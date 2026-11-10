/**
 * Pure guard logic: parameter validation, review, and delegation to the
 * shell seam. No DSH imports here, so the behaviour is unit-testable offline.
 */

import path from 'node:path';
import { reviewPowerShell } from './policy/rules.mjs';
import { toDto } from './dto.js';
import { reviewWithModel } from './model-review.js';
import { readLiveSettings } from './live-settings.js';
import { resolveApiKey } from './credentials.js';
import { beginReview, finishReview, markPhase } from './review-state.js';
import { PROVIDER_DEFAULTS } from './settings.js';

const RISK_UNKNOWN = 'unknown';
const MODE_LABELS = { rules: '仅规则', manual: '人工确认', hybrid: '模型复核', native: '原生' };

/**
 * Rule verdicts that no model or human may overturn. Deliberately short: the
 * point is a floor under catastrophic mistakes, not a second review pass.
 */
const HARD_DENY = new Set([
  'DESTRUCTIVE_ROOT',
  'PROTECTED_PATH',
  'DISK_OPERATION',
  'SYSTEM_MODIFICATION',
  'ENCODED_COMMAND',
  // A command whose own operands are missing is not "probably fine": its effect
  // depends on shell recovery behaviour we cannot model.
  'MALFORMED_COMMAND'
]);

export class GuardDenied extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'GuardDenied';
    this.code = 'CUSTOMS_DENIED';
    this.reason = reason;
  }
}

export class GuardInvalidArgs extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardInvalidArgs';
    this.code = 'INVALID_ARGS';
  }
}

export function toolNameFor(mode) {
  return mode === 'replace' ? 'pwsh' : 'pwsh_guarded';
}

export function validateArgs(args) {
  if (typeof args?.command !== 'string' || args.command.trim() === '') {
    throw new GuardInvalidArgs('invalid command: expected a non-empty string');
  }
  if (typeof args?.description !== 'string' || args.description.trim() === '') {
    throw new GuardInvalidArgs('invalid description: expected a non-empty string');
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new GuardInvalidArgs(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
  }
}

/** Resolve the per-call workdir against the session directory. */
export function resolveWorkdir(modelWorkdir, sessionCwd) {
  if (modelWorkdir === undefined) return sessionCwd;
  if (sessionCwd !== undefined && !path.isAbsolute(modelWorkdir)) return path.resolve(sessionCwd, modelWorkdir);
  return modelWorkdir;
}

/**
 * Run one guarded PowerShell call.
 *
 * @param {object} ctx  plugin context with shell / shellEnv / workingDirectory
 * @param {object} args model arguments
 * @param {object} exec tool execution context
 * @param {{denyOnUnknown?: boolean}} options
 * @returns {Promise<object>} foreground DTO
 */
export async function runGuarded(ctx, args, exec, options = {}) {
  validateArgs(args);

  const cwd = exec?.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  const workdir = resolveWorkdir(args.workdir, cwd);

  // One resolution per call: bundle config, optionally overlaid with the live
  // profile patch so a mode switch applies without a restart. The key itself
  // lives in the credential store, not in the patch.
  const merged = { ...(options.settings ?? {}), ...(options.live === true ? readLiveSettings() : {}) };
  const settings = { ...merged, apiKey: resolveApiKey(merged) };

  // The provider owns the endpoint. A stale `baseURL` from an earlier provider
  // pick produced "DeepSeek key → opencode.ai" and a guaranteed 401, so the
  // provider's documented endpoint wins when the stored host disagrees.
  //
  // The key itself is the strongest signal: an `sk-` key can only belong to
  // DeepSeek, an `oc_sk_` key only to opencode. A stored provider that disagrees
  // with the key shape is stale by definition.
  if (typeof settings.apiKey === 'string' && settings.apiKey.startsWith('sk-') && settings.provider !== 'deepseek') {
    settings.provider = 'deepseek';
    settings.baseURL = PROVIDER_DEFAULTS.deepseek.baseURL;
    settings.model = PROVIDER_DEFAULTS.deepseek.model;
  }
  if (typeof settings.apiKey === 'string' && settings.apiKey.startsWith('oc_sk_') && settings.provider !== 'opencode-go') {
    settings.provider = 'opencode-go';
    settings.baseURL = PROVIDER_DEFAULTS['opencode-go'].baseURL;
    settings.model = PROVIDER_DEFAULTS['opencode-go'].model;
  }
  const defaults = PROVIDER_DEFAULTS[settings.provider];
  if (defaults !== undefined) {
    const hostOf = (value) => {
      try {
        return new URL(String(value ?? '')).host;
      } catch {
        return '';
      }
    };
    const storedHost = hostOf(settings.baseURL);
    const expectedHost = hostOf(defaults.baseURL);
    if (storedHost !== expectedHost) {
      settings.baseURL = defaults.baseURL;
      settings.model = defaults.model;
    }
  }

  // Native mode is the escape hatch: no rules, no review, straight to the
  // executor — the same surface the stock tool offers.
  if ((settings.reviewMode ?? 'rules') === 'native') return executeAllowed();

  const reviewId = beginReview({ command: args.command, cwd: workdir ?? process.cwd() });
  const allowNow = (detail) => { finishReview(reviewId, 'allowed', detail); return executeAllowed(); };
  try {
    return await decideUnderReview();
  } catch (error) {
    finishReview(reviewId, 'denied', error?.reason ?? error?.code ?? String(error?.message ?? error));
    throw error;
  }

  async function decideUnderReview() {
    const verdict = reviewPowerShell({
      command: args.command,
      cwd: workdir ?? process.cwd(),
      denyOnUnknown: options.denyOnUnknown !== false
    });
    markPhase(reviewId, 'rules', 'running');
  if (verdict.decision !== 'allow') {
    const reviewMode = settings.reviewMode ?? 'rules';
    const unknown = verdict.risk === RISK_UNKNOWN;

    // A short list no reviewer can overturn: wiping a drive or home, touching a
    // protected path, disk/registry surgery, opaque encoded commands. Everything
    // else stays appealable to the model in hybrid mode.
    if (HARD_DENY.has(verdict.reason_code)) {
      throw new GuardDenied(
        `CUSTOMS_DENIED: ${verdict.reason_code}\n${verdict.explain}\n属于不可上诉的硬拒绝清单，未执行。`,
        verdict.reason_code
      );
    }

    if (unknown && reviewMode === 'manual') {
      // Human plays the reviewer's role: the call leaks to the normal approval
      // prompt, exactly like a deployment without this plugin.
      const approval = typeof options.approval === 'function' ? options.approval() : options.approval ?? ctx.get?.('approval');
      const agent = exec?.agent;
      const policy = approval?.effectivePolicy?.(agent?.session);
      if (approval === undefined || agent === undefined) return allowNow('manual');

      // Delegated sessions run with approvals disabled (`never`). There is no
      // human to ask there, so the documented behaviour is to keep the stock
      // policy: refuse the unclassified command.
      if (policy === 'never') {
        throw new GuardDenied(
          `CUSTOMS_DENIED: HUMAN_UNAVAILABLE\n当前是委派会话（审批被禁用），人工确认不可用。\n未执行。可改用「模型复核」挡位，或把命令改写成规则可判定的形式。`,
          'HUMAN_UNAVAILABLE'
        );
      }

      const outcome = await approval.request({
        agent,
        toolName: 'pwsh',
        ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
        ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        reason: humanReason(args, workdir ?? process.cwd(), verdict)
      });

      if (outcome === 'allowed-once') return allowNow('manual');
      if (outcome !== 'unavailable') {
        throw new GuardDenied(
          `CUSTOMS_DENIED: HUMAN_${String(outcome).toUpperCase()}\n人工未放行这条命令。\n未执行。`,
          `HUMAN_${String(outcome).toUpperCase()}`
        );
      }

      // No answerer at all: honour the configured fallback for this case only.
      if (settings.manualFallback === 'allow') return allowNow('fallback');
      await reviewByModel({ args, workdir, settings, options, code: 'HUMAN_UNAVAILABLE' });
      return allowNow('model');
    }

    // Hybrid always gives the model a say — including an appeal against a rule
    // denial, so a well-justified `git push` is not stopped by a pattern match.
    if (reviewMode === 'hybrid') {
      const ruleDenied = !unknown;
      const approval = typeof options.approval === 'function' ? options.approval() : options.approval ?? ctx.get?.('approval');
      const agent = exec?.agent;
      const policy = approval?.effectivePolicy?.(agent?.session);
      markPhase(reviewId, 'model', 'running');
      const modelVerdict = await callModel({ args, workdir, settings, options });

      if (modelVerdict.decision === 'allow') return allowNow('model');

      const explicitDeny = modelVerdict.code === 'MODEL_DENY';
      const humanAvailable = approval !== undefined && agent !== undefined && policy !== 'never';

      // Explicit escalation: the reviewer said no, the caller asks a human once.
      // The authority quote is context for that human only — the automated
      // reviewer never treats model-written text as proof.
      if (explicitDeny && args.escalate === true && humanAvailable === false) {
        throw new GuardDenied(
          `CUSTOMS_DENIED: HUMAN_UNAVAILABLE\n已请求人工复核，但当前会话没有可用的人工通道（委派会话禁用审批，或 approval 服务未就绪）。\n未执行。`,
          'HUMAN_UNAVAILABLE'
        );
      }
      if (explicitDeny && args.escalate === true && humanAvailable) {
        const quoted =
          typeof args.authority === 'string' && args.authority.trim() !== ''
            ? `\n\n调用方引用的授权（未验证）：${args.authority.trim().slice(0, 300)}`
            : '';
        const outcome = await approval.request({
          agent,
          toolName: 'pwsh',
          ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
          reason: `${humanReason(args, workdir ?? process.cwd(), verdict)}\n模型判定：${modelVerdict.reason}${quoted}`
        });
        if (outcome === 'allowed-once') return allowNow('human-escalated');
        throw new GuardDenied(
          `CUSTOMS_DENIED: HUMAN_${String(outcome).toUpperCase()}\n模型拒绝后已转人工；人工未放行。\n未执行。`,
          `HUMAN_${String(outcome).toUpperCase()}`
        );
      }

      // The model could not decide (timeout, outage, truncation): a human is
      // the fallback in a normal session, never a silent refusal.
      if (!explicitDeny && humanAvailable) {
        const outcome = await approval.request({
          agent,
          toolName: 'pwsh',
          ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
          reason: humanReason(args, workdir ?? process.cwd(), verdict)
        });
        if (outcome === 'allowed-once') return allowNow('human');
        throw new GuardDenied(
          `CUSTOMS_DENIED: HUMAN_${String(outcome).toUpperCase()}\n模型复核未完成（${modelVerdict.code}），已转人工；人工未放行。\n未执行。`,
          `HUMAN_${String(outcome).toUpperCase()}`
        );
      }

      const ruleNote = ruleDenied ? `（规则判定：${verdict.reason_code}）` : '';
      // Point at the real cause: a missing intention is fixable by the model in
      // one turn, while "rewrite the command" is advice that does not apply.
      const hint =
        modelVerdict.code === 'MODEL_DENY'
          ? args.intention === undefined || String(args.intention).trim() === ''
            ? '未提供 intention（目的与预期效果）；补充后可以重试这条命令。'
            : '模型判定该命令与所述目的不符，或风险高于目的所需。'
          : `模型复核不可用（${modelVerdict.code}）；这不是命令本身被判定为危险。`;
      throw new GuardDenied(
        `CUSTOMS_DENIED: ${modelVerdict.code}\n${modelVerdict.reason}${modelVerdict.detail === undefined ? '' : ` ${modelVerdict.detail}`}${ruleNote}\n未执行。${hint}`,
        modelVerdict.code
      );
    }

    if (unknown) {
      // Rules mode has no model to argue with; escalation still lets a human
      // decide when the caller explicitly asks for it.
      const approval = typeof options.approval === 'function' ? options.approval() : options.approval ?? ctx.get?.('approval');
      const agent = exec?.agent;
      const policy = approval?.effectivePolicy?.(agent?.session);
      if (args.escalate === true && approval !== undefined && agent !== undefined && policy !== 'never') {
        const quoted =
          typeof args.authority === 'string' && args.authority.trim() !== ''
            ? `\n\n调用方引用的授权（未验证）：${args.authority.trim().slice(0, 300)}`
            : '';
        const outcome = await approval.request({
          agent,
          toolName: 'pwsh',
          ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
          reason: `${humanReason(args, workdir ?? process.cwd(), verdict)}${quoted}`
        });
        if (outcome === 'allowed-once') return allowNow('human-escalated');
        throw new GuardDenied(
          `CUSTOMS_DENIED: HUMAN_${String(outcome).toUpperCase()}\n已转人工；人工未放行。\n未执行。`,
          `HUMAN_${String(outcome).toUpperCase()}`
        );
      }

      const label = MODE_LABELS[reviewMode] ?? reviewMode;
      const hint =
        reviewMode === 'rules'
          ? '当前是「仅规则」，未识别命令一律拒绝；可在 设置 → 自动审核 改为「人工确认」或「模型复核」。'
          : `当前审核模式：${label}。`;
      throw new GuardDenied(
        `CUSTOMS_DENIED: ${verdict.reason_code}\n${verdict.explain}\n${hint}\n未执行。不要重试同一命令，改用安全写法或把改动限制在工作目录内。`,
        verdict.reason_code
      );
    }

    throw new GuardDenied(
      `CUSTOMS_DENIED: ${verdict.reason_code}\n${verdict.explain}\n未执行。`,
      verdict.reason_code
    );
  }

    // The rules cleared it, but a delete/write inside the workspace can still be
    // wrong for the stated intention. Ask the reviewer while the change is cheap
    // to refuse; the switch exists because this costs one model call each time.
    const reviewMode = settings.reviewMode ?? 'rules';
    const destructiveScoped =
      verdict.reason_code === 'SCOPED_DELETE' || verdict.reason_code === 'SCOPED_WRITE';
    if (destructiveScoped && settings.scopedModelReview !== false && reviewMode !== 'native') {
      markPhase(reviewId, 'model', 'running');
      const modelVerdict = await callModel({ args, workdir, settings, options });
      if (modelVerdict.decision !== 'allow') {
        const hint =
          args.intention === undefined || String(args.intention).trim() === ''
            ? '未提供 intention（目的与预期效果）；补充后可以重试这条命令。'
            : '模型判定该命令与所述目的不符，或风险高于目的所需。';
        throw new GuardDenied(
          `CUSTOMS_DENIED: ${modelVerdict.code}\n${modelVerdict.reason}${modelVerdict.detail === undefined ? '' : ` ${modelVerdict.detail}`}\n未执行。${hint}`,
          modelVerdict.code
        );
      }
      return allowNow('model');
    }

    return allowNow('rules');
  }


  /** Raw model call used by the hybrid mode (its result is inspected there). */
  async function callModel({ args, workdir, settings, options: opts }) {
    const reviewer = opts?.reviewer ?? options.reviewer ?? reviewWithModel;
    return reviewer({
      command: args.command,
      cwd: workdir ?? process.cwd(),
      description: args.description,
      intention: args.intention,
      settings
    });
  }

  /** Model-only path for the manual fallback: throws unless it allows. */
  async function reviewByModel({ args, workdir, settings, options: opts, code }) {
      markPhase(reviewId, 'model', 'running');
    const modelVerdict = await callModel({ args, workdir, settings, options: opts });
    if (modelVerdict.decision !== 'allow') {
      const failure = code ?? modelVerdict.code;
      const why = code === 'HUMAN_UNAVAILABLE' ? '没有可用的审批人，且模型复核未放行' : '模型复核未放行';
      throw new GuardDenied(
        `CUSTOMS_DENIED: ${failure}\n${modelVerdict.reason}\n未执行。${why}；请改写命令或把改动限制在工作目录内。`,
        failure
      );
    }
  }


  /** Resolve the spec and run it — the only path that reaches the executor. */
  async function executeAllowed() {
    // Same sandbox wiring as the native pwsh tool: resolve the standing policy
    // for this agent when the executor supports sandboxing.
    const sandboxPolicy = ctx.shell.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy');
    const policy =
      sandboxPolicy === undefined
        ? undefined
        : sandboxPolicy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session });

    const spec = ctx.shell.resolve({
      command: args.command,
      ...(workdir === undefined ? {} : { workdir }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      dshEnv: ctx.shellEnv.collect(exec),
      ...(policy === undefined ? {} : { sandboxPolicy: policy }),
      signal: exec.signal
    });

    const result = await (await ctx.shell.execute(spec)).result();
    if (result.aborted === true) {
      const aborted = new Error('tool call aborted');
      aborted.name = 'AbortError';
      aborted.code = 'TOOL_ABORTED';
      throw aborted;
    }
    return toDto(result, spec.workdir);
  }
}

/**
 * Build the human-facing prompt: what the model itself wrote (its description),
 * the exact command, the directory, and why the rules could not clear it.
 * Multi-line and labelled so the approval UI reads cleanly.
 */
export function humanReason(args, workdir, verdict) {
  const command = args.command.length > 800 ? `${args.command.slice(0, 800)}…` : args.command;
  return [
    args.description,
    '',
    `命令: ${command}`,
    `目录: ${workdir}`,
    `规则: ${verdict.reason_code} — ${verdict.explain}`
  ].join('\n');
}
