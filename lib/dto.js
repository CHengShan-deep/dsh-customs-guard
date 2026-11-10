/**
 * Result DTO and rendering.
 *
 * The executor already returns canonical facts; this file only re-shapes them
 * into the same foreground DTO the native pwsh tool returns, so a replacement
 * tool stays drop-in for the model and for Host presentations.
 *
 * The schema below is plain JSON Schema limited to the DSH subset
 * (type/oneOf/properties/required/additionalProperties/items/enum/const +
 * description/title). Property-level `required: true` is the defineTool spec
 * form and is NOT valid here.
 */

export const FOREGROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string' },
    cwd: { type: 'string' },
    exitCode: { type: 'number' },
    signal: { type: 'string' },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    timeoutMs: { type: 'number' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        spillPath: { type: 'string' }
      }
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        spillPath: { type: 'string' }
      }
    },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'denied'],
      properties: {
        mode: { type: 'string' },
        denied: { type: 'boolean' },
        enforcement: { type: 'string' },
        runnerFailed: { type: 'boolean' }
      }
    }
  }
};

function stream(value) {
  const out = {
    text: typeof value?.text === 'string' ? value.text : '',
    truncated: value?.truncated === true
  };
  if (typeof value?.spillPath === 'string' && value.spillPath !== '') out.spillPath = value.spillPath;
  return out;
}

/** Canonical executor result -> model-facing foreground DTO. */
export function toDto(result, workdir) {
  const dto = {
    kind: 'foreground',
    exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 0,
    timedOut: result?.timedOut === true,
    aborted: result?.aborted === true,
    stdout: stream(result?.stdout),
    stderr: stream(result?.stderr)
  };
  if (typeof workdir === 'string' && workdir !== '') dto.cwd = workdir;
  if (typeof result?.signal === 'string' && result.signal !== '') dto.signal = result.signal;
  if (typeof result?.timeoutMs === 'number') dto.timeoutMs = result.timeoutMs;
  if (result?.sandbox !== undefined) {
    dto.sandbox = {
      mode: String(result.sandbox.mode ?? 'unknown'),
      denied: result.sandbox.denied === true
    };
    if (typeof result.sandbox.enforcement === 'string') dto.sandbox.enforcement = result.sandbox.enforcement;
    if (typeof result.sandbox.runnerFailed === 'boolean') dto.sandbox.runnerFailed = result.sandbox.runnerFailed;
  }
  return dto;
}

/** Render the DTO into one text block, matching the native marker contract. */
export function renderResult(value) {
  const out = typeof value?.stdout?.text === 'string' ? value.stdout.text : '';
  const err = typeof value?.stderr?.text === 'string' ? value.stderr.text : '';
  const body = [out, err].filter((part) => part !== '').join('\n').replace(/\n+$/, '') || '(no output)';

  const markers = [];
  if (value?.sandbox?.denied === true) {
    markers.push(`[sandbox: file access denied under ${value.sandbox.mode} mode]`);
  }
  if (value?.timedOut === true) {
    markers.push(typeof value.timeoutMs === 'number' ? `[timed out after ${value.timeoutMs}ms]` : '[timed out]');
  }
  if (typeof value?.signal === 'string' && value.signal !== '') {
    markers.push(`[killed by signal: ${value.signal}]`);
  } else if (value?.aborted === true) {
    markers.push('[aborted]');
  } else if (value?.timedOut !== true) {
    markers.push(`[exit code: ${typeof value?.exitCode === 'number' ? value.exitCode : 0}]`);
  }

  return [body, ...markers].join('\n');
}
