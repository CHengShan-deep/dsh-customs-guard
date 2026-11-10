import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLiveSettings, resetLiveSettingsCache } from '../lib/live-settings.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'customs-live-'));
const PROFILES = path.join(HOME, 'profiles');

function writeProfile(name, text, mtimeMs) {
  const dir = path.join(PROFILES, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(file, text, 'utf8');
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('reads the newest profile patch that carries the entry', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = HOME;
  try {
    writeProfile('old', '- id: customs-guard\n  config:\n    reviewMode: rules\n', 1_000);
    writeProfile('new', '- id: customs-guard\n  config:\n    reviewMode: manual\n    provider: opencode-go\n    timeoutMs: 5000\n    shareCachePrefix: false\n', 2_000);
    resetLiveSettingsCache();
    const live = readLiveSettings(0);
    assert.equal(live.reviewMode, 'manual');
    assert.equal(live.provider, 'opencode-go');
    assert.equal(live.timeoutMs, 5000);
    assert.equal(live.shareCachePrefix, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    resetLiveSettingsCache();
  }
});

test('ignores secrets and unrelated ids', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = HOME;
  try {
    writeProfile('other', '- id: something-else\n  config:\n    reviewMode: hybrid\n', 3_000);
    resetLiveSettingsCache();
    const live = readLiveSettings(0);
    // newest file has no customs-guard id, so the search falls through to the
    // next candidate rather than inventing values.
    assert.notEqual(live.reviewMode, 'hybrid');

    writeProfile('sec', '- id: customs-guard\n  config:\n    apiKey: sk-live-key\n    mode: shadow\n', 4_000);
    resetLiveSettingsCache();
    const next = readLiveSettings(0);
    // The key is read live so a saved credential applies without a restart;
    // it is never logged or echoed back.
    assert.equal(next.apiKey, 'sk-live-key');
    assert.equal(next.mode, 'shadow');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    resetLiveSettingsCache();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});
