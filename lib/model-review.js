/**
 * Optional model review for commands the deterministic rules cannot classify.
 *
 * Provider-neutral: both DeepSeek official and opencode-go speak the
 * OpenAI-compatible `/chat/completions` shape. Anything unexpected fails
 * closed — the caller keeps its default deny.
 */

const MAX_RETRIES = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_DELAY_MS = 20000;

/** Declared cap stays at 500; the effective one grows only after a cut answer. */
const DECLARED_MAX_TOKENS = 500;
const CAP_STEP = 50;
const CAP_CEILING = 4000;
const HARD_TRUNCATION_TOKENS = 1000;
const MAX_TRUNCATION_RETRIES = 3;
/** How many times a non-JSON reviewer answer is discarded and re-asked. */
const MAX_BAD_FORMAT_RETRIES = 2;
const ARG_LIMIT = 500;

const caps = new Map();

function effectiveCap(key) {
  return caps.get(key) ?? DECLARED_MAX_TOKENS;
}

function bumpCap(key) {
  const next = Math.min(CAP_CEILING, effectiveCap(key) + CAP_STEP);
  caps.set(key, next);
  return next;
}

/** Test hook. */
export function resetCapState() {
  caps.clear();
}

/**
 * Clip a command body so one long argument cannot dominate the prompt.
 * Splitting is best-effort: when the text cannot be split into arguments, the
 * whole body is clipped instead. Weighting counts one per character (CJK 1,
 * latin letters 1 each, matching "2 个英文字母计 2").
 */
/**
 * Rough nesting measure: separators +1. Two pipes or an `&&` chain (3+
 * segments) is complex enough to deserve reasoning effort.
 */
export function nestingDepth(command) {
  const operators = command.match(/\|\||&&|\||;|\$\(/g);
  return (operators === null ? 0 : operators.length) + 1;
}

export function clipCommand(command) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command)) !== null) parts.push(match[0]);

  const clip = (text) => {
    let weight = 0;
    let end = text.length;
    let index = 0;
    for (const ch of text) {
      weight += 1;
      index += ch.length;
      if (weight > ARG_LIMIT) {
        end = index - ch.length;
        return `${text.slice(0, end)}…[已截断]`;
      }
    }
    return text;
  };

  if (parts.length <= 1) return clip(command);
  return parts.map(clip).join(' ');
}

const SYSTEM_PROMPT = [
  'You are a shell command safety reviewer for an AI coding agent on Windows.',
  'You receive one PowerShell command, its working directory, a short UI description,',
  'and (optionally) the stated intention: the goal the caller wants to achieve.',
  'Judge the command against the intention: allow only if the command plausibly',
  'serves that intention and its effects stay reversible.',
  'Deny when it could destroy data outside the working directory, modify the system,',
  'exfiltrate secrets, or cannot be reasoned about.',
  'If the intention is missing, deny any command that deletes, moves, or overwrites',
  'something, even inside the working directory: without a stated goal the effect is',
  'unverifiable. If the intention contradicts the command, deny.',
  'Treat an incomplete command as unsafe, not as "it will just error out":',
  'unbalanced quotes or brackets, a dangling pipe or operator, a destructive verb',
  'with no target, or a flag whose value is missing all mean the real effect is',
  'unknown. If the stated goal would require arguments the command does not carry,',
  'deny.',
  'Reply with JSON only: {"decision":"allow"|"deny","reason":"<=20 words"}.'
].join(' ');

const NO_INTENTION = '(none stated — judge from the description, and deny if the command is destructive or ambiguous)';

/**
 * @param {object} input
 * @param {string} input.command
 * @param {string} input.cwd
 * @param {{provider?:string, apiKey?:string, baseURL?:string, model?:string, timeoutMs?:number}} input.settings
 * @param {typeof fetch} [input.fetchImpl]
 * @returns {Promise<{decision:'allow'|'deny', reason:string, code:string}>}
 */
import { randomUUID } from 'node:crypto';

export async function reviewWithModel(input, fetchImpl = globalThis.fetch) {
  const { command, cwd, description, intention, settings } = input;
  const apiKey = settings?.apiKey ?? '';
  const baseURL = (settings?.baseURL ?? '').replace(/\/+$/, '');
  const model = settings?.model ?? '';
  const timeoutMs = typeof settings?.timeoutMs === 'number' ? settings.timeoutMs : 8000;

  if (apiKey === '') return { decision: 'deny', reason: '未配置 API 密钥', code: 'MODEL_NOT_CONFIGURED' };
  if (baseURL === '') return { decision: 'deny', reason: '未配置 API 地址', code: 'MODEL_NOT_CONFIGURED' };
  if (model === '') return { decision: 'deny', reason: '未配置模型', code: 'MODEL_NOT_CONFIGURED' };
  if (typeof fetchImpl !== 'function') return { decision: 'deny', reason: '运行时不支持 fetch', code: 'MODEL_UNAVAILABLE' };

  // Shared-prefix caching: keep the system prompt byte-identical across every
  // call and put the variable part last. Turning it off appends a nonce, which
  // forces a cache miss on any provider — useful as an A/B baseline.
  const shareCachePrefix = settings?.shareCachePrefix !== false;
  const systemPrompt = shareCachePrefix ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n<!-- nonce:${randomUUID()} -->`;
  const cacheKey = shareCachePrefix ? 'customs-guard' : randomUUID();
  const routeKey = `${settings?.provider ?? 'deepseek'}:${model}`;

  const payload = {
    model,
    temperature: 0,
    // Declared cap; the effective one grows by 50 whenever the provider cuts
    // the answer short, so a long command cannot turn into a false deny.
    max_tokens: effectiveCap(routeKey),
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Working directory: ${cwd}\nSummary: ${description ?? '(none)'}\nIntention: ${intention === undefined || intention === '' ? NO_INTENTION : String(intention).slice(0, 500)}\nCommand:\n${clipCommand(command)}` }
    ]
  };
  // DeepSeek honours JSON mode; keep it there and leave other providers on the
  // plain shape they document.
  if (settings?.provider === 'deepseek') {
    payload.response_format = { type: 'json_object' };
    // Simple commands do not need deliberation (19 vs 195 tokens). Nested ones
    // (3+ segments) get low-effort thinking so the safety judgement stays sound.
    payload.thinking = nestingDepth(command) >= 3 ? { type: 'enabled' } : { type: 'disabled' };
  }
  // Only providers that document a prompt-cache key get one: DeepSeek caches
  // by prefix automatically and rejects unknown parameters.
  if (settings?.provider === 'opencode-go') payload.prompt_cache_key = cacheKey;

  const attemptOnce = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const status = response.status;
        // Diagnostics: a 401 here has to be distinguishable from a 401 caused by
        // a masked/empty key, so the endpoint and key shape travel with the code.
        const host = (() => {
          try {
            return new URL(baseURL).host;
          } catch {
            return 'invalid-url';
          }
        })();
        const keyShape = `key=${apiKey.slice(0, 6)}…len=${apiKey.length}`;
        // The provider's own message is the only way to tell an expired key from
        // a request-shape rejection; keep it short and readable in the deny text.
        let bodyText = '';
        try {
          if (typeof response.text === 'function') {
            bodyText = (await response.text()).replace(/\s+/g, ' ').slice(0, 140);
          }
        } catch {
          bodyText = '';
        }
        return {
          result: {
            decision: 'deny',
            reason: `HTTP ${status}`,
            detail: `@${host} ${keyShape}${bodyText === '' ? '' : ` ${bodyText}`}`,
            code: 'MODEL_HTTP_ERROR'
          },
          retryable: status === 429 || status >= 500
        };
      }

      const body = await response.json();
      const choice = body?.choices?.[0];
      const content = choice?.message?.content;
      const completion = body?.usage?.completion_tokens;
      // A cut answer is not a verdict: drop it, raise the effective cap and ask
      // again immediately.
      if (choice?.finish_reason === 'length' || (typeof completion === 'number' && completion >= HARD_TRUNCATION_TOKENS)) {
        return { result: { decision: 'deny', reason: '响应被截断', code: 'MODEL_TRUNCATED' }, truncated: true };
      }
      if (typeof content !== 'string') {
        // A silent/malformed answer is a reviewer mistake, not a verdict: retry
        // instead of letting it leak into the main model as a denial.
        return { result: { decision: 'deny', reason: '响应缺少内容', code: 'MODEL_BAD_RESPONSE' }, retryable: true, badFormat: true };
      }

      const parsed = parseDecision(content);
      if (parsed === undefined) {
        return { result: { decision: 'deny', reason: '响应不是合法 JSON 判定', code: 'MODEL_BAD_RESPONSE' }, retryable: true, badFormat: true };
      }
      return { result: parsed, retryable: false };
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE';
      return {
        result: { decision: 'deny', reason: String(error?.message ?? error).slice(0, 120), code },
        retryable: true
      };
    } finally {
      clearTimeout(timer);
    }
  };

  // Unavailable means transient: retry with a capped backoff. The longest single
  // wait stays at 20s, and the whole budget is bounded by retries * that cap.
  const retries = Number.isInteger(settings?.retries) ? Math.max(0, Math.min(5, settings.retries)) : MAX_RETRIES;
  const delays = Array.isArray(settings?.retryDelaysMs) ? settings.retryDelaysMs : BACKOFF_MS;

  let last = { decision: 'deny', reason: '未尝试', code: 'MODEL_UNAVAILABLE' };
  let truncations = 0;
  let badFormats = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const outcome = await attemptOnce();
    if (outcome.truncated === true) {
      last = outcome.result;
      if (truncations >= MAX_TRUNCATION_RETRIES) break;
      truncations += 1;
      bumpCap(routeKey);
      payload.max_tokens = effectiveCap(routeKey);
      attempt -= 1; // a truncation retry does not consume the transient budget
      continue;
    }
    if (outcome.badFormat === true) {
      // Reviewer answer was not the required JSON: drop it, remind once, ask
      // again immediately. Only a reviewer that keeps failing becomes a denial.
      last = outcome.result;
      if (badFormats >= MAX_BAD_FORMAT_RETRIES) break;
      badFormats += 1;
      payload.messages[1].content +=
        '\n\nYour previous reply was not the required JSON. Reply with JSON only, nothing else: {"decision":"allow"|"deny","reason":"<=20 words"}.';
      attempt -= 1; // does not consume the transient budget
      continue;
    }
    if (!outcome.retryable) return outcome.result;
    last = outcome.result;
    if (attempt === retries) break;
    const wait = Math.min(Number(delays[attempt] ?? MAX_DELAY_MS), MAX_DELAY_MS);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return last;
}

function parseDecision(content) {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match !== null) {
      try {
        value = JSON.parse(match[0]);
      } catch {
        /* fall through to the tolerant scan below */
      }
    }
  }
  if (value?.decision !== 'allow' && value?.decision !== 'deny') {
    // A truncated stream can still carry the verdict; take it rather than
    // failing closed on an otherwise usable decision.
    const loose = /"decision"\s*:\s*"?(allow|deny)/.exec(trimmed);
    if (loose === null) return undefined;
    const decision = loose[1];
    const reasonMatch = /"reason"\s*:\s*"([^"]*)/.exec(trimmed);
    return {
      decision,
      reason: reasonMatch === null ? '' : reasonMatch[1].slice(0, 200),
      code: decision === 'allow' ? 'MODEL_ALLOW' : 'MODEL_DENY'
    };
  }
  const reason = typeof value.reason === 'string' ? value.reason.slice(0, 200) : '';
  return { decision: value.decision, reason, code: value.decision === 'allow' ? 'MODEL_ALLOW' : 'MODEL_DENY' };
}
