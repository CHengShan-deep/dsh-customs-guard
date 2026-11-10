import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY_REF, credentialsPath, readCredential, resolveApiKey, saveCredential } from '../lib/credentials.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'customs-cred-'));

function withHome(fn) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = HOME;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test('missing file reads as empty', () => {
  withHome(() => {
    assert.equal(credentialsPath(), path.join(HOME, '.credentials.yaml'));
    assert.equal(readCredential(KEY_REF), '');
  });
});

test('save then read round-trips and keeps other entries', () => {
  withHome(() => {
    const file = credentialsPath();
    fs.writeFileSync(file, 'version: 1\nrefs:\n  OTHER_KEY: abc\nrecords:\n  x:\n    kind: grant\n', 'utf8');
    saveCredential(KEY_REF, 'sk-test');
    assert.equal(readCredential(KEY_REF), 'sk-test');
    assert.equal(readCredential('OTHER_KEY'), 'abc');
    assert.match(fs.readFileSync(file, 'utf8'), /records:\n {2}x:/);
  });
});

test('overwrites an existing ref instead of duplicating it', () => {
  withHome(() => {
    saveCredential(KEY_REF, 'first');
    saveCredential(KEY_REF, 'second');
    const text = fs.readFileSync(credentialsPath(), 'utf8');
    assert.equal(text.match(/CUSTOMS_GUARD_API_KEY/g).length, 1);
    assert.equal(readCredential(KEY_REF), 'second');
  });
});

test('explicit setting wins over the store', () => {
  withHome(() => {
    saveCredential(KEY_REF, 'from-store');
    assert.equal(resolveApiKey({}), 'from-store');
    assert.equal(resolveApiKey({ apiKey: 'from-setting' }), 'from-setting');
    assert.equal(resolveApiKey({ apiKey: '   ' }), 'from-store');
  });
});
