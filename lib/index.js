/**
 * DSH Customs Guard: an in-process review gate for the native `pwsh` tool.
 *
 * No hook, no MCP, no port, no token — and deliberately no runtime imports
 * outside Node built-ins. External DSH plugins cannot resolve
 * `@deepseek-ai/dsh-tools` from their own path (the shipped third-party
 * plugins bundle those deps for exactly this reason); registering the raw
 * definition object avoids that failure mode entirely.
 *
 * Modes:
 *   shadow  - registers `pwsh_guarded`; nothing stock is touched.
 *   replace - registers `pwsh`; requires `- id: tool-pwsh` + `disabled: true`.
 */

import fs from 'node:fs';
import { FOREGROUND_SCHEMA, renderResult } from './dto.js';
import { GuardDenied, GuardInvalidArgs, runGuarded, toolNameFor } from './guard.js';
import { Config } from './settings.js';
import { reviewSnapshot } from './review-state.js';
import { readLiveSettings } from './live-settings.js';
import { resolveApiKey } from './credentials.js';

export const name = '@dsh-local/dsh-customs-guard';
export const inject = ['tools', 'shell', 'shellEnv', 'workingDirectory', 'approval'];
export { Config };

/** Process-wide state: the package may be mounted twice in one runtime. */
const routesState = { registered: false };
const installedAgents = new WeakMap();

/** The model-facing parameter schema (plain JSON Schema, DSH subset). */
const PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'command'],
  properties: {
    description: {
      type: 'string',
      description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).'
    },
    intention: {
      type: 'string',
      description:
        'Why this command is needed and what it should achieve: the goal, the expected effect, and what must stay untouched. ' +
        'Reviewed with the command; a missing or vague intention makes a destructive command more likely to be refused. ' +
        'Required whenever the command deletes, moves, or writes outside the session workspace.'
    },
    command: { type: 'string', description: 'The PowerShell command to execute.' },
    timeoutMs: {
      type: 'number',
      description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.'
    },
    workdir: {
      type: 'string',
      description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.'
    },
    escalate: {
      type: 'boolean',
      description:
        'Ask the human once when automated review refuses this command. The human sees the command, the intention and the ' +
        'reviewer reason, and decides. Honoured only in a session that has a human; delegated sessions stay refused.'
    },
    authority: {
      type: 'string',
      description:
        'Optional quote of the user instruction that authorizes this command, e.g. "用户：删掉那个仓库重建". ' +
        'Shown to the human as context; never treated as proof by the automated reviewer, because it cannot be verified.'
    }
  }
};

class CustomsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
  }
}

function descriptionFor(mode) {
  const base =
    'Guarded PowerShell: execute a PowerShell command and return its output. ' +
    'The command is reviewed before execution; destructive or unprovable commands are refused with CUSTOMS_DENIED. ' +
    'Provide description before command; use workdir instead of cd. ' +
    '`description` is the UI summary; `intention` states the goal and expected effect, and is what an approval decision is judged against — ' +
    'fill it whenever the command deletes, moves, or touches anything outside the session workspace. ' +
    'If automated review refuses something the user has already authorized, retry once with `escalate: true` so a human decides; ' +
    '`authority` quotes the user instruction for that human, but it is context, not proof.';
  return mode === 'replace'
    ? `${base} This is the only pwsh tool in this deployment.`
    : `${base} (guarded preview tool; the stock pwsh is still available.)`;
}

export function apply(ctx, config = {}) {
  const mode = config.mode === 'replace' ? 'replace' : 'shadow';
  const toolName = toolNameFor(mode);
  const denyOnUnknown = config.denyOnUnknown !== false;
  // Resolved once from the plugin root: the agent-scoped ctx only carries the
  // services it declares, so an approval lookup there returned undefined and
  // made `escalate` a no-op.
  const approval = (() => {
    try {
      return ctx.get?.('approval');
    } catch {
      return undefined;
    }
  })();

  trace(`apply: mode=${mode} tool=${toolName}`);

  registerReviewRoute(ctx, config);

  // Registration *and* execution use the agent-scoped context: it outlives a
  // plugin remount, and declaring every service we touch keeps the getters
  // valid (`cannot get property X without inject` otherwise).
  const definition = (scoped) => ({
    name: toolName,
    description: descriptionFor(mode),
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: FOREGROUND_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }]
    },
    async execute(args, exec) {
      try {
        // Diagnostic: the resolved review mode decides whether the model runs at
        // all, and it has been observed to disagree with the patch file.
        if (Date.now() - (routesState.lastModeTrace ?? 0) > 5000) {
          routesState.lastModeTrace = Date.now();
          const live = readLiveSettings();
          const merged = { ...(config ?? {}), ...live };
          const key = String(resolveApiKey(merged) ?? '');
          trace(
            `reviewMode: config=${config?.reviewMode} live=${live.reviewMode} effective=${live.reviewMode ?? config?.reviewMode} ` +
              `key=${key === '' ? '(empty)' : `${key.slice(0, 6)}…len=${key.length}`} base=${merged.baseURL} model=${merged.model}`
          );
        }
        return await runGuarded(scoped, args, exec, { denyOnUnknown, settings: config, live: true, approval });
      } catch (error) {
        if (error instanceof GuardDenied || error instanceof GuardInvalidArgs) {
          throw new CustomsError(error.message, error.code);
        }
        if (error?.code === 'TOOL_ABORTED') throw new CustomsError('tool call aborted', 'TOOL_ABORTED');
        throw error;
      }
    }
  });

  // The model's tool view is layered: agent scope > preset ancestor scope >
  // global. Registering here (root ctx) lands in `global`, which the web
  // preset's own `pwsh` shadows — that is why a same-named registration
  // "succeeds" yet the model keeps seeing the stock tool. Register into each
  // agent's own scope instead, where our layer wins.
  const installForAgent = (agent) => {
    if (agent?.ctx?.inject === undefined) return;
    const previous = installedAgents.get(agent);
    if (previous !== undefined) {
      try {
        previous();
      } catch {
        /* the earlier agent scope may already be gone */
      }
      installedAgents.delete(agent);
    }
    try {
      const dispose = agent.ctx.inject(
        ['tools', 'shell', 'shellEnv', 'workingDirectory'],
        (scoped) => scoped.tools.register(definition(scoped))
      );
      installedAgents.set(agent, typeof dispose === 'function' ? dispose : () => {});
      trace(`tool registered: ${toolName} (agent scope)`);
    } catch (error) {
      trace(`agent registration failed: ${(error && error.message) || error}`);
    }
  };

  let agents;
  try {
    agents = ctx.get?.('agents');
  } catch {
    agents = undefined;
  }

  if (agents?.list !== undefined && typeof ctx.on === 'function') {
    try {
      for (const agent of agents.list()) installForAgent(agent);
      ctx.effect(() => {
        const offCreated = ctx.on('agent/created', ({ agent }) => installForAgent(agent));
        const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
          const dispose = installedAgents.get(agent);
          if (dispose !== undefined) {
            try {
              dispose();
            } catch {
              /* ignore */
            }
            installedAgents.delete(agent);
          }
        });
        return () => {
          offCreated?.();
          offDisposed?.();
        };
      }, 'customs-guard: agents');
      trace('agent hooks installed');
      return;
    } catch (error) {
      trace(`agent hooks failed: ${(error && error.message) || error}`);
    }
  }

  // Fallback for hosts without an agent registry: global registration. It is
  // invisible to presets that declare their own tool of the same name.
  trace('agents service unavailable; falling back to global registration');
  try {
    const dispose = ctx.effect(() => ctx.tools.register(definition(ctx)), `customs-guard: ${toolName}`);
    trace(`tool registered: ${toolName} (global)`);
    void dispose;
  } catch (error) {
    trace(`tool registration failed: ${(error && error.message) || error}`);
    console.warn('[customs-guard] tool registration failed:', (error && error.message) || error);
  }
}

/**
 * Append one line to `.runtime.log` next to the plugin. The Host writes no log
 * file of its own, and stdout is invisible in the packaged app, so this is the
 * only way to see why a registration was skipped.
 */
function trace(line) {
  try {
    fs.appendFileSync(new URL('../.runtime.log', import.meta.url), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* tracing must never break loading */
  }
}

/**
 * Header state + connectivity probe, both served from the same process.
 *
 * `ctx.inject` is the right seam: the connection service mounts *after* this
 * plugin on some boots, and polling `ctx.get` from a timer stopped working once
 * the plugin fiber went inactive — the service has to be declared, not grabbed.
 */
function registerReviewRoute(ctx, config) {
  if (routesState.registered) return;
  try {
    ctx.inject(['connection'], (scoped) => {
      const connection = scoped.connection;
      if (connection?.fetch?.register === undefined) {
        trace('review route: connection has no fetch.register');
        return () => {};
      }
      if (routesState.registered) return () => {};
      try {
        connection.fetch.register({
          path: '/api/customs-guard/review',
          methods: ['GET'],
        // The shared channel reads the body mode off the route; omitting it made
        // the bridge answer 400 before our handler ran.
        requestBody: 'buffered',
        fetch: async () => {
          // The pill needs to know whether model review is even active: outside
          // hybrid there is nothing to probe and the state is not "ready".
          const now = Date.now();
          if (now - (routesState.lastReviewHit ?? 0) > 10000) {
            routesState.lastReviewHit = now;
            trace('review route hit');
          }
          const merged = { ...(config ?? {}), ...readLiveSettings() };
          return new Response(JSON.stringify({ ...reviewSnapshot(), reviewMode: merged.reviewMode ?? 'rules' }), {
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
          });
        }
      });
      } catch (error) {
        trace(`review route register failed: ${(error && error.message) || error}`);
      }
      try {
      connection.fetch.register({
        path: '/api/customs-guard/probe',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          trace('probe route hit');
          const merged = { ...(config ?? {}), ...readLiveSettings() };
          if ((merged.reviewMode ?? 'rules') !== 'hybrid') {
            return new Response(JSON.stringify({ ok: false, ms: 0, message: '当前不是模型复核模式' }), {
              headers: { 'content-type': 'application/json' }
            });
          }
          const key = resolveApiKey(merged);
          const base = String(merged.baseURL ?? '').replace(/\/+$/, '');
          if (key === '' || base === '') {
            return new Response(
              JSON.stringify({ ok: false, ms: 0, message: key === '' ? '未配置密钥' : '未配置 API 地址' }),
              { headers: { 'content-type': 'application/json' } }
            );
          }
          const started = Date.now();
          try {
            const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
            return new Response(JSON.stringify({ ok: response.ok, status: response.status, ms: Date.now() - started }), {
              headers: { 'content-type': 'application/json' }
            });
          } catch (error) {
            return new Response(
              JSON.stringify({ ok: false, status: 0, ms: Date.now() - started, message: String((error && error.message) || error) }),
              { headers: { 'content-type': 'application/json' } }
            );
          }
        }
      });
      } catch (error) {
        trace(`probe route register failed: ${(error && error.message) || error}`);
      }
      routesState.registered = true;
      trace('review + probe routes registered');
      return () => {
        routesState.registered = false;
      };
    });
  } catch (error) {
    trace(`review route failed: ${(error && error.message) || error}`);
  }
}
