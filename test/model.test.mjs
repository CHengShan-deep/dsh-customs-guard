import test from 'node:test';
import assert from 'node:assert/strict';
import { clipCommand, nestingDepth, resetCapState, reviewWithModel } from '../lib/model-review.js';

const base = { command: 'make', cwd: 'C:\\work' };

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

test('the reviewer sees the intention separately from the summary', async () => {
  let userMessage = '';
  const settings = { apiKey: 'k', baseURL: 'https://x/v1', model: 'm' };
  const reply = { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };

  await reviewWithModel(
    {
      command: 'Remove-Item build\\old -Recurse',
      cwd: 'C:\\work',
      description: '清理构建产物',
      intention: '删除上一轮构建生成的 build\\old 目录，避免缓存污染；不触碰源码',
      settings
    },
    fakeFetch(async (_url, init) => {
      userMessage = JSON.parse(init.body).messages[1].content;
      return reply;
    })
  );

  assert.match(userMessage, /Summary: 清理构建产物/);
  assert.match(userMessage, /Intention: 删除上一轮构建生成的 build\\old 目录/);

  await reviewWithModel(
    { command: 'Remove-Item x -Recurse', cwd: 'C:\\work', description: '清理', settings },
    fakeFetch(async (_url, init) => {
      userMessage = JSON.parse(init.body).messages[1].content;
      return reply;
    })
  );

  // A missing intention must be visible as missing, not silently replaced by
  // the summary: the reviewer is told to be stricter in that case.
  assert.match(userMessage, /Intention: \(none stated/);
});

test('missing settings fail closed', async () => {
  const r = await reviewWithModel({ command: 'make', cwd: 'C:\\work', settings: {} }, fakeFetch(async () => ({ ok: true, json: async () => ({}) })));
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'MODEL_NOT_CONFIGURED');
});

test('missing base URL fails closed', async () => {
  const r = await reviewWithModel({ ...base, settings: { apiKey: 'k', model: 'm' } }, fakeFetch(async () => ({ ok: true, json: async () => ({}) })));
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'MODEL_NOT_CONFIGURED');
});

test('allow verdict is parsed', async () => {
  const seen = [];
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm' } },
    fakeFetch(async (url, init) => {
      seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"read-only build"}' } }] }) };
    })
  );
  assert.equal(r.decision, 'allow');
  assert.equal(seen[0].url, 'https://x/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer k');
  assert.equal(seen[0].body.model, 'm');
});

test('fenced JSON is parsed', async () => {
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm' } },
    fakeFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"decision":"deny","reason":"touches system"}\n```' } }] }) }))
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'MODEL_DENY');
});

test('a cut answer is discarded and retried, then reported', async () => {
  resetCapState();
  let calls = 0;
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm' } },
    fakeFetch(async () => {
      calls += 1;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"decision":"allow","reason":"' } }], usage: { completion_tokens: 500 } }) };
    })
  );
  assert.equal(calls, 4); // first attempt + 3 truncation retries
  assert.equal(r.code, 'MODEL_TRUNCATED');
  resetCapState();
});

test('each truncation raises the effective cap by 50', async () => {
  resetCapState();
  const sizes = [];
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm' } },
    fakeFetch(async (url, init) => {
      sizes.push(JSON.parse(init.body).max_tokens);
      if (sizes.length === 1) {
        return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"decision"' } }], usage: { completion_tokens: 1000 } }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
    })
  );
  assert.deepEqual(sizes, [500, 550]);
  assert.equal(r.decision, 'allow');
  resetCapState();
});

test('clipCommand bounds each argument and leaves short commands alone', () => {
  const short = 'git commit -m "hello"';
  assert.equal(clipCommand(short), short);
  const long = `echo "${'a'.repeat(700)}" tail`;
  const clipped = clipCommand(long);
  assert.match(clipped, /…\[已截断\]/);
  assert.ok(clipped.length < long.length);
});

test('deepseek gets JSON mode, opencode does not', async () => {
  const seen = [];
  await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', provider: 'deepseek' } },
    fakeFetch(async (url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
    })
  );
  assert.deepEqual(seen[0].response_format, { type: 'json_object' });
  assert.equal(seen[0].max_tokens, 500);
  assert.equal(seen[0].reasoning_effort, 'low');
  assert.deepEqual(seen[0].thinking, { type: 'disabled' });

  await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', provider: 'opencode-go' } },
    fakeFetch(async (url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
    })
  );
  assert.equal(seen[1].response_format, undefined);
});

test('nested commands get low-effort thinking, flat ones do not', async () => {
  assert.equal(nestingDepth('make -j8'), 1);
  assert.equal(nestingDepth('git status; git log | head'), 3);
  const seen = [];
  await reviewWithModel(
    { command: 'Get-ChildItem | Where-Object { $_ } | Measure-Object; echo done', cwd: 'C:\\w', settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', provider: 'deepseek' } },
    fakeFetch(async (url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
    })
  );
  assert.deepEqual(seen[0].thinking, { type: 'enabled' });
});

test('HTTP errors and junk responses deny', async () => {
  const settings = { apiKey: 'k', baseURL: 'https://x/v1', model: 'm' };
  const http = await reviewWithModel({ ...base, settings }, fakeFetch(async () => ({ ok: false, status: 401 })));
  assert.equal(http.decision, 'deny');
  assert.equal(http.code, 'MODEL_HTTP_ERROR');

  const junk = await reviewWithModel({ ...base, settings }, fakeFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'sure, go ahead' } }] }) })));
  assert.equal(junk.decision, 'deny');
  assert.equal(junk.code, 'MODEL_BAD_RESPONSE');
});

test('a non-JSON reply is discarded and re-asked instead of denying', async () => {
  let calls = 0;
  const settings = { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', retryDelaysMs: [0, 0, 0] };
  const result = await reviewWithModel(
    { ...base, settings },
    fakeFetch(async () => {
      calls += 1;
      const content = calls === 1 ? 'sure, go ahead' : '{"decision":"allow","reason":"scoped cleanup"}';
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    })
  );
  assert.equal(result.decision, 'allow');
  assert.equal(result.code, 'MODEL_ALLOW');
  assert.equal(calls, 2);
});

test('network failure denies', async () => {
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', retries: 0 } },
    fakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    })
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'MODEL_UNAVAILABLE');
});

test('transient failures are retried, then the verdict is used', async () => {
  let calls = 0;
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', retryDelaysMs: [0, 0, 0, 0, 0] } },
    fakeFetch(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
    })
  );
  assert.equal(calls, 3);
  assert.equal(r.decision, 'allow');
});

test('client errors are not retried', async () => {
  let calls = 0;
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', retryDelaysMs: [0, 0, 0, 0, 0] } },
    fakeFetch(async () => {
      calls += 1;
      return { ok: false, status: 401, json: async () => ({}) };
    })
  );
  assert.equal(calls, 1);
  assert.equal(r.code, 'MODEL_HTTP_ERROR');
});

test('server errors exhaust the retry budget', async () => {
  let calls = 0;
  const r = await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', retryDelaysMs: [0, 0, 0, 0, 0] } },
    fakeFetch(async () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    })
  );
  assert.equal(calls, 6); // first attempt + 5 retries
  assert.equal(r.code, 'MODEL_HTTP_ERROR');
});

test('shared prefix: stable system prompt, cache key only for supporting providers', async () => {
  const seen = [];
  await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', provider: 'opencode-go' } },
    fakeFetch(async (url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
    })
  );
  assert.equal(seen[0].prompt_cache_key, 'customs-guard');
  assert.ok(!seen[0].messages[0].content.includes('nonce:'));

  const deepseek = [];
  await reviewWithModel(
    { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', provider: 'deepseek' } },
    fakeFetch(async (url, init) => {
      deepseek.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
    })
  );
  // DeepSeek caches by prefix automatically and rejects unknown parameters.
  assert.equal(deepseek[0].prompt_cache_key, undefined);
});

test('turning the shared prefix off breaks the cache deterministically', async () => {
  const seen = [];
  for (let i = 0; i < 2; i += 1) {
    await reviewWithModel(
      { ...base, settings: { apiKey: 'k', baseURL: 'https://x/v1', model: 'm', provider: 'opencode-go', shareCachePrefix: false } },
      fakeFetch(async (url, init) => {
        seen.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"allow","reason":"ok"}' } }] }) };
      })
    );
  }
  assert.match(seen[0].messages[0].content, /nonce:/);
  assert.notEqual(seen[0].messages[0].content, seen[1].messages[0].content);
  assert.notEqual(seen[0].prompt_cache_key, seen[1].prompt_cache_key);
});
