/**
 * Path normalization and containment checks.
 *
 * Windows rules baked in:
 *  - canonical form is forward-slash, lower-case, no trailing separator
 *  - containment requires a separator boundary ("project-evil" is not inside "project")
 *  - realpath first, so junctions cannot masquerade as project paths
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandEnv(value, env = process.env) {
  if (typeof value !== 'string') return value;
  let text = value;
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = os.homedir() + text.slice(1);
  }
  return text
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => (env[k] !== undefined ? env[k] : m))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
      const v = env[a || b];
      return v !== undefined ? v : m;
    });
}

/** Resolve against a base, expanding env vars, and follow symlinks/junctions when possible. */
export function resolveReal(input, base = process.cwd()) {
  const expanded = expandEnv(input);
  const abs = path.resolve(base, expanded);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Canonical comparison key. */
export function canon(input, base = process.cwd()) {
  let p = resolveReal(input, base).replace(/\\/g, '/');
  if (process.platform === 'win32') p = p.toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

export function isWithin(parent, child, base = process.cwd()) {
  const a = canon(parent, base);
  const b = canon(child, base);
  if (a === b) return true;
  const prefix = a.endsWith('/') ? a : `${a}/`;
  return b.startsWith(prefix);
}

export function protectedList(raw, env = process.env) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => canon(expandEnv(item, env), env.HOME || process.cwd()));
}

export function isProtected(target, protectedPaths, base = process.cwd()) {
  const t = canon(target, base);
  return protectedPaths.some((p) => t === p || t.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/** True when the path exists and is a directory. */
export function isExistingDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Absolute path check that also rejects relative forms like "." or "..\\x". */
export function isAbsoluteLike(p) {
  return typeof p === 'string' && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
}
