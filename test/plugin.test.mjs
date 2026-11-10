import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuardDenied, GuardInvalidArgs, humanReason, resolveWorkdir, runGuarded, toolNameFor } from '../lib/guard.js';
import { reviewPowerShell } from '../lib/policy/rules.mjs';
import { FOREGROUND_SCHEMA, renderResult, toDto } from '../lib/dto.js';
import * as plugin from '../lib/index.js';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'customs-plugin-'));

function makeCtx(cwd = WORK) {
  const calls = { resolve: [], execute: [] };
  const ctx = {
    shell: {
      sandboxMode: 'workspace-write',
      resolve(request) {
        calls.resolve.push(request);
        return { ...request, workdir: request.workdir ?? cwd };
      },
      async execute(spec) {
        calls.execute.push(spec);
        return {
          result: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            timeoutMs: spec.timeoutMs ?? 120000,
            stdout: { text: 'C:\\work', truncated: false },
            stderr: { text: '', truncated: false }
          })
        };
      }
    },
    shellEnv: { collect: () => ({ DSH_TEST: '1' }) },
    workingDirectory: { ensure: async () => cwd },
    get: () => undefined
  };
  return { ctx, calls };
}

const exec = { agent: undefined, signal: undefined };

test('tool name follows the mode', () => {
  assert.equal(toolNameFor('shadow'), 'pwsh_guarded');
  assert.equal(toolNameFor('replace'), 'pwsh');
  assert.equal(toolNameFor(undefined), 'pwsh_guarded');
});

test('relative workdir resolves against the session directory', () => {
  assert.equal(resolveWorkdir('src', WORK), path.resolve(WORK, 'src'));
  assert.equal(resolveWorkdir(undefined, WORK), WORK);
  assert.equal(resolveWorkdir('C:\\abs', WORK), 'C:\\abs');
});

test('dangerous command is refused before the executor runs', async () => {
  const { ctx, calls } = makeCtx();
  await assert.rejects(
    () => runGuarded(ctx, { command: 'Remove-Item C:\\Windows -Recurse -Force', description: '清理旧文件' }, exec),
    (error) => error instanceof GuardDenied && error.reason === 'PROTECTED_PATH'
  );
  assert.equal(calls.execute.length, 0);
  assert.equal(calls.resolve.length, 0);
});

test('hard-deny reasons cannot be appealed to the model', async () => {
  const { ctx, calls } = makeCtx();
  await assert.rejects(
    () =>
      runGuarded(ctx, { command: 'Remove-Item C:\\Windows -Recurse -Force', description: '清理系统目录' }, exec, {
        settings: { reviewMode: 'hybrid', apiKey: 'test-key' },
        reviewer: async () => ({ decision: 'allow', reason: '看起来没问题' })
      }),
    (error) => error instanceof GuardDenied && error.reason === 'PROTECTED_PATH'
  );
  assert.equal(calls.execute.length, 0);
});

test('a drive root with a trailing separator is a destructive root', () => {
  for (const command of ['Remove-Item C:\\ -Recurse -Force', 'rm -rf C:\\']) {
    const verdict = reviewPowerShell({ command, cwd: WORK });
    assert.equal(verdict.decision, 'deny', command);
    assert.equal(verdict.reason_code, 'DESTRUCTIVE_ROOT', command);
  }
});

test('a rules-allowed delete is still checked against the intention', async () => {
  const { ctx, calls } = makeCtx();
  await assert.rejects(
    () =>
      runGuarded(ctx, { command: 'Remove-Item .\\probe-mismatch -Recurse -Force', description: '查看文件列表' }, exec, {
        settings: { reviewMode: 'hybrid', apiKey: 'test-key' },
        reviewer: async () =>
          ({ decision: 'deny', code: 'MODEL_DENY', reason: 'No intention stated; destructive delete' })
      }),
    (error) => error instanceof GuardDenied && error.reason === 'MODEL_DENY'
  );
  assert.equal(calls.execute.length, 0);
});

test('the scoped-model switch off keeps rules-allowed deletes quiet', async () => {
  const { ctx, calls } = makeCtx();
  const dto = await runGuarded(
    ctx,
    { command: 'Remove-Item .\\probe-mismatch -Recurse -Force', description: '清理临时目录' },
    exec,
    {
      settings: { reviewMode: 'hybrid', apiKey: 'test-key', scopedModelReview: false },
      reviewer: async () => {
        throw new Error('reviewer must not run when the switch is off');
      }
    }
  );
  assert.equal(dto.kind, 'foreground');
  assert.equal(calls.execute.length, 1);
});

test('a DeepSeek key overrides a stale opencode provider', async () => {
  const { ctx } = makeCtx();
  let seenBase = '';
  let seenProvider = '';
  await runGuarded(
    ctx,
    { command: 'git push origin main', description: '推送' },
    exec,
    {
      settings: {
        reviewMode: 'hybrid',
        apiKey: 'sk-deepseek-test',
        provider: 'opencode-go',
        baseURL: 'https://opencode.ai/inference/openai/v1',
        model: 'deepseek-v4.1-flash'
      },
      reviewer: async (input) => {
        seenBase = input.settings.baseURL;
        seenProvider = input.settings.provider;
        return { decision: 'allow', reason: 'ok' };
      }
    }
  );
  assert.equal(seenProvider, 'deepseek');
  assert.equal(seenBase, 'https://api.deepseek.com/v1');
});

test('escalate routes a model denial to the human, who can approve once', async () => {
  const { ctx, calls, asked } = makeCtxWithApproval('allowed-once');
  const dto = await runGuarded(
    ctx,
    {
      command: 'git push --force origin main',
      description: '覆盖远端历史',
      intention: '把错误的提交历史强制覆盖为已验证版本',
      escalate: true,
      authority: '用户：把那个仓库删掉重建'
    },
    humanExec,
    {
      settings: { reviewMode: 'hybrid', apiKey: 'k' },
      reviewer: async () => ({ decision: 'deny', code: 'MODEL_DENY', reason: 'force push rewrites shared history' })
    }
  );
  assert.equal(dto.kind, 'foreground');
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /force push rewrites shared history/);
  assert.match(asked[0].reason, /用户：把那个仓库删掉重建/);
  assert.equal(calls.execute.length, 1);
});

test('escalate is useless where no human exists (delegated session)', async () => {
  const { ctx, calls } = makeCtx();
  ctx.get = (name) =>
    name === 'approval'
      ? { effectivePolicy: () => 'never', request: async () => 'allowed-once' }
      : undefined;
  await assert.rejects(
    () =>
      runGuarded(
        ctx,
        { command: 'git push --force origin main', description: '覆盖', escalate: true },
        humanExec,
        {
          settings: { reviewMode: 'hybrid', apiKey: 'k' },
          reviewer: async () => ({ decision: 'deny', code: 'MODEL_DENY', reason: 'rewrites history' })
        }
      ),
    (error) => error instanceof GuardDenied && error.reason === 'MODEL_DENY'
  );
  assert.equal(calls.execute.length, 0);
});

test('escalate cannot lift a hard-deny reason', async () => {
  const { ctx, calls } = makeCtxWithApproval('allowed-once');
  await assert.rejects(
    () =>
      runGuarded(ctx, { command: 'Remove-Item C:\\Windows -Recurse -Force', description: '清理', escalate: true }, humanExec, {
        settings: { reviewMode: 'hybrid', apiKey: 'k' }
      }),
    (error) => error instanceof GuardDenied && error.reason === 'PROTECTED_PATH'
  );
  assert.equal(calls.execute.length, 0);
});

test('approval resolved from the plugin root works on a scoped ctx', async () => {
  // The agent-scoped ctx only exposes declared services, so `ctx.get('approval')`
  // is undefined there; the root-resolved instance must be used instead.
  const { ctx, calls } = makeCtx();
  const asked = [];
  const approval = {
    request: async (request) => {
      asked.push(request);
      return 'allowed-once';
    }
  };
  const dto = await runGuarded(
    ctx,
    { command: 'git push --force origin main', description: '覆盖远端', escalate: true, authority: '用户：允许覆盖' },
    humanExec,
    {
      settings: { reviewMode: 'hybrid', apiKey: 'k' },
      approval,
      reviewer: async () => ({ decision: 'deny', code: 'MODEL_DENY', reason: 'rewrites history' })
    }
  );
  assert.equal(dto.kind, 'foreground');
  assert.equal(asked.length, 1);
  assert.equal(calls.execute.length, 1);
});

test('hybrid lets the model overturn a rule denial', async () => {
  const { ctx, calls } = makeCtx();
  const seen = [];
  const dto = await runGuarded(
    ctx,
    { command: 'git push origin main', description: '推送已验证的提交' },
    exec,
    {
      settings: { reviewMode: 'hybrid', apiKey: 'test-key' },
      reviewer: async ({ command }) => {
        seen.push(command);
        return { decision: 'allow', reason: '意图明确且已验证' };
      }
    }
  );
  assert.equal(dto.kind, 'foreground');
  assert.deepEqual(seen, ['git push origin main']);
  assert.equal(calls.execute.length, 1);
});

test('hybrid still refuses when the model denies a rule denial', async () => {
  const { ctx, calls } = makeCtx();
  await assert.rejects(
    () =>
      runGuarded(ctx, { command: 'git push --force origin main', description: '强制推送' }, exec, {
        settings: { reviewMode: 'hybrid', apiKey: 'test-key' },
        reviewer: async () => ({ decision: 'deny', code: 'MODEL_DENY', reason: '强制推送不可恢复' })
      }),
    (error) => error instanceof GuardDenied && error.reason === 'MODEL_DENY'
  );
  assert.equal(calls.execute.length, 0);
});

test('allowed command runs through the shell seam', async () => {
  const { ctx, calls } = makeCtx();
  const dto = await runGuarded(ctx, { command: 'Get-Location', description: '确认工作目录' }, exec);
  assert.equal(dto.kind, 'foreground');
  assert.equal(dto.exitCode, 0);
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].command, 'Get-Location');
  assert.deepEqual(calls.execute[0].dshEnv, { DSH_TEST: '1' });
});

test('the dto never carries description or workdir', async () => {
  const { ctx } = makeCtx();
  const dto = await runGuarded(ctx, { command: 'Get-Location', description: 'SECRET-INTENT' }, exec);
  const text = JSON.stringify(dto);
  assert.equal(text.includes('SECRET-INTENT'), false);
});

test('missing description is an argument error', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(() => runGuarded(ctx, { command: 'Get-Location' }, exec), (error) => error instanceof GuardInvalidArgs);
});

test('unknown command is refused unless explicitly relaxed', async () => {
  const { ctx, calls } = makeCtx();
  await assert.rejects(() => runGuarded(ctx, { command: 'make', description: '构建' }, exec), (error) => error instanceof GuardDenied);
  assert.equal(calls.execute.length, 0);
  const dto = await runGuarded(ctx, { command: 'make', description: '构建' }, exec, { denyOnUnknown: false });
  assert.equal(dto.kind, 'foreground');
});

function makeCtxWithApproval(outcome) {
  const base = makeCtx();
  const asked = [];
  base.ctx.get = (name) =>
    name === 'approval'
      ? {
          request: async (req) => {
            asked.push(req);
            return outcome;
          }
        }
      : undefined;
  return { ...base, asked };
}

const humanExec = { agent: { session: {} }, signal: undefined };

test('manual mode: unknown command leaks to the human and runs when allowed', async () => {
  const { ctx, calls, asked } = makeCtxWithApproval('allowed-once');
  const dto = await runGuarded(ctx, { command: 'make', description: '构建项目' }, humanExec, { settings: { reviewMode: 'manual' } });
  assert.equal(dto.kind, 'foreground');
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /构建项目/);
  assert.match(asked[0].reason, /make/);
  assert.match(asked[0].reason, /UNCLASSIFIED/);
  assert.equal(calls.execute.length, 1);
});

test('manual mode: human refusal denies without executing', async () => {
  const { ctx, calls } = makeCtxWithApproval('rejected');
  await assert.rejects(
    () => runGuarded(ctx, { command: 'make', description: '构建' }, humanExec, { settings: { reviewMode: 'manual' } }),
    (error) => error instanceof GuardDenied && error.reason === 'HUMAN_REJECTED'
  );
  assert.equal(calls.execute.length, 0);
});

test('manual mode: hard rule denies never reach the human', async () => {
  const { ctx, calls, asked } = makeCtxWithApproval('allowed-once');
  await assert.rejects(
    () => runGuarded(ctx, { command: 'Remove-Item C:\\Windows -Recurse -Force', description: '清理' }, humanExec, { settings: { reviewMode: 'manual' } }),
    (error) => error instanceof GuardDenied && error.reason === 'PROTECTED_PATH'
  );
  assert.equal(asked.length, 0);
  assert.equal(calls.execute.length, 0);
});

test('manual mode without an approval service leaks through like no plugin', async () => {
  const { ctx, calls } = makeCtx();
  const dto = await runGuarded(ctx, { command: 'make', description: '构建' }, humanExec, { settings: { reviewMode: 'manual' } });
  assert.equal(dto.kind, 'foreground');
  assert.equal(calls.execute.length, 1);
});

test('manual mode: approvals disabled elsewhere fall back to the model', async () => {
  const { ctx, calls, asked } = makeCtxWithApproval('unavailable');
  const dto = await runGuarded(ctx, { command: 'make', description: '构建' }, humanExec, {
    settings: { reviewMode: 'manual', manualFallback: 'model' },
    reviewer: async () => ({ decision: 'allow', reason: 'build only', code: 'MODEL_ALLOW' })
  });
  assert.equal(dto.kind, 'foreground');
  assert.equal(asked.length, 1);
  assert.equal(calls.execute.length, 1);
});

test('manual mode: model fallback denial is reported as HUMAN_UNAVAILABLE', async () => {
  const { ctx, calls } = makeCtxWithApproval('unavailable');
  await assert.rejects(
    () =>
      runGuarded(ctx, { command: 'make', description: '构建' }, humanExec, {
        settings: { reviewMode: 'manual', manualFallback: 'model' },
        reviewer: async () => ({ decision: 'deny', reason: 'touches too much', code: 'MODEL_DENY' })
      }),
    (error) => error instanceof GuardDenied && error.reason === 'HUMAN_UNAVAILABLE'
  );
  assert.equal(calls.execute.length, 0);
});

test('manual mode: a never-ask policy skips the request and uses the fallback', async () => {
  const base = makeCtxWithApproval('allowed-once');
  base.ctx.get = (name) =>
    name === 'approval'
      ? {
          effectivePolicy: () => 'never',
          request: async () => {
            throw new Error('must not be called');
          }
        }
      : undefined;
  await assert.rejects(
    () => runGuarded(base.ctx, { command: 'make', description: '构建' }, humanExec, {
      settings: { reviewMode: 'manual', manualFallback: 'allow' }
    }),
    (error) => error instanceof GuardDenied && error.reason === 'HUMAN_UNAVAILABLE'
  );
  assert.equal(base.calls.execute.length, 0);
});

test('manual mode: delegated session refuses instead of asking', async () => {
  const { ctx, calls, asked } = makeCtxWithApproval('allowed-once');
  ctx.get = (name) =>
    name === 'approval' ? { effectivePolicy: () => 'never', request: async () => { throw new Error('no'); } } : undefined;
  await assert.rejects(
    () => runGuarded(ctx, { command: 'make', description: '构建' }, humanExec, { settings: { reviewMode: 'manual' } }),
    (error) => error instanceof GuardDenied && error.reason === 'HUMAN_UNAVAILABLE'
  );
  assert.equal(asked.length, 0);
  assert.equal(calls.execute.length, 0);
});

test('hybrid mode: model outage falls back to the human', async () => {
  const { ctx, calls, asked } = makeCtxWithApproval('allowed-once');
  const dto = await runGuarded(ctx, { command: 'make', description: '构建' }, humanExec, {
    settings: { reviewMode: 'hybrid' },
    reviewer: async () => ({ decision: 'deny', reason: 'timeout', code: 'MODEL_TIMEOUT' })
  });
  assert.equal(dto.kind, 'foreground');
  assert.equal(asked.length, 1);
  assert.equal(calls.execute.length, 1);
});

test('hybrid mode: an explicit model deny does not reach the human', async () => {
  const { ctx, calls, asked } = makeCtxWithApproval('allowed-once');
  await assert.rejects(
    () =>
      runGuarded(ctx, { command: 'make', description: '构建' }, humanExec, {
        settings: { reviewMode: 'hybrid' },
        reviewer: async () => ({ decision: 'deny', reason: 'destructive', code: 'MODEL_DENY' })
      }),
    (error) => error instanceof GuardDenied && error.reason === 'MODEL_DENY'
  );
  assert.equal(asked.length, 0);
  assert.equal(calls.execute.length, 0);
});

test('native mode skips every review and goes straight to the executor', async () => {
  const base = makeCtx();
  const dto = await runGuarded(
    base.ctx,
    { command: 'Remove-Item C:\\Windows -Recurse -Force', description: '删除系统目录' },
    humanExec,
    { settings: { reviewMode: 'native' } }
  );
  assert.equal(dto.kind, 'foreground');
  assert.equal(base.calls.execute.length, 1);
});

test('human prompt names the directory and the rule verdict', () => {
  const reason = humanReason({ command: 'make', description: '构建项目' }, WORK, {
    reason_code: 'UNCLASSIFIED',
    explain: '无法证明安全'
  });
  assert.match(reason, /构建项目/);
  assert.match(reason, /make/);
  assert.match(reason, /UNCLASSIFIED/);
  assert.match(reason, /目录/);
});

test('render keeps the exit marker and truncation facts', () => {
  const dto = toDto({ exitCode: 3, stdout: { text: 'out', truncated: true }, stderr: { text: 'err', truncated: false } }, WORK);
  const text = renderResult(dto);
  assert.match(text, /out/);
  assert.match(text, /err/);
  assert.match(text, /\[exit code: 3\]/);
  assert.equal(dto.stdout.truncated, true);
});

test('render reports timeouts and signals', () => {
  assert.match(renderResult({ timedOut: true, timeoutMs: 1000, exitCode: 1 }), /timed out after 1000ms/);
  assert.match(renderResult({ signal: 'SIGKILL', exitCode: 1 }), /killed by signal: SIGKILL/);
});

test('plugin modules import nothing outside node built-ins', () => {
  const files = ['index.js', 'guard.js', 'dto.js', 'policy/rules.mjs', 'policy/lexer.mjs', 'policy/paths.mjs', 'policy/errors.mjs'];
  for (const file of files) {
    const text = fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'), `${file} imports external package: ${specifier}`);
    }
  }
});

test('output schema stays inside the supported DSH subset', () => {
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title']);
  const walk = (node, path) => {
    for (const key of Object.keys(node)) {
      assert.ok(allowed.has(key), `${path}.${key} is not a supported keyword`);
    }
    if (node.properties) for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${name}`);
  };
  walk(FOREGROUND_SCHEMA, 'schema');
  assert.ok(Array.isArray(FOREGROUND_SCHEMA.required));
  assert.ok(FOREGROUND_SCHEMA.required.includes('kind'));
});

test('apply survives a context without an agent registry', () => {
  const registered = [];
  const makeCtx = (get) => ({
    effect: (fn) => {
      fn();
      return () => {};
    },
    get,
    tools: { register: (definition) => (registered.push(definition.name), () => {}) },
    shell: {},
    shellEnv: {},
    workingDirectory: {}
  });

  // Some cordis versions throw for a service the plugin did not inject; that
  // must not remove the tool and the settings page.
  assert.doesNotThrow(() =>
    plugin.apply(makeCtx(() => {
      throw new Error('service not found');
    }), {})
  );
  assert.deepEqual(registered, ['pwsh_guarded']);

  plugin.apply(makeCtx(() => undefined), { mode: 'replace' });
  assert.deepEqual(registered, ['pwsh_guarded', 'pwsh']);
});

test('replace registers into each agent scope, not the global layer', () => {
  const agentScoped = [];
  const globalTools = [];
  const listeners = {};

  const makeAgent = (id) => ({
    id,
    ctx: {
      inject: (deps, callback) => {
        callback({ tools: { register: (definition) => (agentScoped.push(`${id}:${definition.name}`), () => {}) } });
        return () => {};
      }
    }
  });

  const first = makeAgent('a1');
  const ctx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    get: (name) => (name === 'agents' ? { list: () => [first] } : undefined),
    on: (event, handler) => {
      listeners[event] = handler;
      return () => {};
    },
    tools: { register: (definition) => (globalTools.push(definition.name), () => {}) },
    shell: {},
    shellEnv: {},
    workingDirectory: {}
  };

  plugin.apply(ctx, { mode: 'replace' });
  assert.deepEqual(agentScoped, ['a1:pwsh']);
  assert.deepEqual(globalTools, []);

  // An agent created later is covered too, instead of silently missing the tool.
  const second = makeAgent('a2');
  listeners['agent/created']({ agent: second });
  assert.deepEqual(agentScoped, ['a1:pwsh', 'a2:pwsh']);
});

test('package.json is BOM-free (DSH reads it with JSON.parse)', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const bytes = fs.readFileSync(file);
  assert.notEqual(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, true);
  assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')));
});

test('teardown', () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  assert.ok(true);
});
