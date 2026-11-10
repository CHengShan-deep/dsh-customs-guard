/**
 * Read the plugin's own settings straight from the profile patch file.
 *
 * The Host materialises bundle config once at load; a settings write only
 * persists to the profile patch, so without this the running tool would keep
 * the config it booted with until the next restart. Reading the small patch
 * file (mtime-cached) makes mode switches take effect on the next call.
 *
 * Only non-secret fields are taken from the file: the API key is stored by the
 * Host's secret path and never re-read here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY_ID = 'customs-guard';
const LIVE_KEYS = new Set(['mode', 'reviewMode', 'provider', 'baseURL', 'model', 'timeoutMs', 'shareCachePrefix', 'apiKey', 'manualFallback']);

let cache = { at: 0, file: '', value: {} };
const TTL_MS = 1000;

function profilesRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles');
}

function candidatePatches() {
  const root = profilesRoot();
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  const files = [];
  for (const dir of dirs) {
    const file = path.join(root, dir.name, 'cordis.patch.yml');
    try {
      const stat = fs.statSync(file);
      files.push({ file, mtime: stat.mtimeMs });
    } catch {
      /* profile without a patch file */
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** Parse the `- id: customs-guard` block of a patch list. */
function parseBlock(text) {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^- id:/.test(trimmed)) {
      inBlock = trimmed === `- id: ${ENTRY_ID}`;
      continue;
    }
    if (!inBlock) continue;
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(trimmed);
    if (match === null) continue;
    const [, key, raw] = match;
    if (!LIVE_KEYS.has(key)) continue;
    let value = raw.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key === 'timeoutMs') {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = num;
    } else if (key === 'shareCachePrefix') {
      out[key] = value === 'true';
    } else if (value !== '') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @returns {object} live overrides (possibly empty); never throws.
 */
export function readLiveSettings(now = Date.now()) {
  if (cache.at !== 0 && now - cache.at < TTL_MS) return cache.value;
  cache = { at: now, file: cache.file, value: {} };
  try {
    for (const { file } of candidatePatches()) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes(ENTRY_ID)) continue;
      cache = { at: now, file, value: parseBlock(text) };
      return cache.value;
    }
  } catch {
    /* fall through to no overrides */
  }
  return cache.value;
}

/** Test hook. */
export function resetLiveSettingsCache() {
  cache = { at: 0, file: '', value: {} };
}
