/**
 * Minimal credentials store.
 *
 * DSH already keeps `~/.dsh/.credentials.yaml` with a `refs:` map; we reuse it
 * instead of inventing a second secret file, and we never copy the value into
 * the profile patch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEY_REF = 'CUSTOMS_GUARD_API_KEY';

export function credentialsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

export function readCredential(ref = KEY_REF, file = credentialsPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^[A-Za-z]/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const match = /^\s{2}([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (match !== null && match[1] === ref) return match[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/** Upsert one ref, preserving every other line byte-for-byte. */
export function saveCredential(ref, value, file = credentialsPath()) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = 'version: 1\nrefs:\n';
  }
  const lines = text.split(/\r?\n/);
  const line = `  ${ref}: ${value}`;

  let refsIndex = lines.findIndex((entry) => /^refs:\s*$/.test(entry));
  if (refsIndex === -1) {
    lines.push('refs:');
    refsIndex = lines.length - 1;
  }

  let replaced = false;
  let insertAt = refsIndex + 1;
  for (let index = refsIndex + 1; index < lines.length; index += 1) {
    const entry = lines[index];
    if (/^[A-Za-z]/.test(entry)) break;
    if (/^\s{2}[A-Za-z0-9_.-]+:/.test(entry)) {
      insertAt = index + 1;
      const match = /^\s{2}([A-Za-z0-9_.-]+):/.exec(entry);
      if (match !== null && match[1] === ref) {
        lines[index] = line;
        replaced = true;
        break;
      }
    }
  }
  if (!replaced) lines.splice(insertAt, 0, line);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/**
 * The key the guard should actually use: an explicit setting wins, otherwise
 * the credential store. Empty string means "not configured".
 */
export function resolveApiKey(settings = {}) {
  const direct = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  if (direct !== '') return direct;
  return readCredential(KEY_REF);
}
