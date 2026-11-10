/**
 * Deterministic policy. No model, no network, no transcript.
 *
 * Principle (from the plan): prove it cannot write badly, or that it can be
 * restored, before allowing it. Anything unprovable is `unknown`, never `none`.
 */

import { RISK, REASON, worseRisk, explain } from './errors.mjs';
import { lex } from './lexer.mjs';
import { canon, isProtected, isWithin, resolveReal } from './paths.mjs';

const READ_ONLY_BASH = new Set([
  'ls', 'dir', 'pwd', 'cd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'tree', 'file', 'stat',
  'which', 'where', 'type', 'whoami', 'hostname', 'echo', 'printf', 'date', 'sleep',
  'true', 'false', 'test', 'uname', 'du', 'df', 'basename', 'dirname', 'realpath',
  'get-childitem', 'get-content', 'get-location', 'get-command', 'get-item', 'test-path',
  'resolve-path', 'select-object', 'where-object', 'measure-object', 'sort-object',
  'format-table', 'out-string', 'write-output', 'write-host', 'convertto-json',
  'compare-object', 'get-process', 'get-service', 'get-date', 'gci', 'gc', 'gl', 'gv',
  // Read-only inspection added after the coverage audit (no write-capable flags
  // in these families; `sort`/`env` stay out because they can write or exec).
  'select-string', 'get-itemproperty', 'get-member', 'get-help', 'get-module',
  'get-variable', 'get-filehash', 'get-acl', 'get-host', 'get-psdrive', 'get-culture',
  'findstr', 'more', 'uniq', 'cut', 'id', 'groups', 'uptime', 'free', 'nproc',
  'readlink', 'sha256sum', 'md5sum', 'printenv', 'arch', 'locale'
]);

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);

const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'blame', 'grep', 'ls-files', 'shortlog'
]);

function baseName(word) {
  const cleaned = String(word ?? '').replace(/^["']|["']$/g, '');
  const parts = cleaned.split(/[\\/]/);
  return (parts[parts.length - 1] || '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
}

function firstNonFlag(words) {
  return words.find((w) => !w.startsWith('-'));
}

function hasAny(words, needles) {
  return words.some((w) => needles.includes(w.toLowerCase()));
}

/** Risk for a path that is about to be written or deleted. */
function targetRisk(target, ctx, kind) {
  const raw = String(target ?? '');
  // A trailing separator used to survive as `C:\` and slip past the root test
  // while still resolving to the drive's current directory.
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (
    raw === '' ||
    raw === '*' ||
    raw === '~' ||
    raw === '$HOME' ||
    raw === '%USERPROFILE%' ||
    /^[a-zA-Z]:$/.test(trimmed) ||
    /^[\\/]+$/.test(raw)
  ) {
    return { risk: RISK.IRREVERSIBLE, reason: REASON.DESTRUCTIVE_ROOT };
  }

  const resolved = resolveReal(raw, ctx.cwd);
  const resolvedKey = canon(resolved);
  if (resolvedKey === canon(ctx.cwd)) return { risk: RISK.IRREVERSIBLE, reason: REASON.DESTRUCTIVE_ROOT };
  // Drive root, whatever the separator or casing.
  if (/^[a-z]:$/.test(resolvedKey) || resolvedKey === '/') {
    return { risk: RISK.IRREVERSIBLE, reason: REASON.DESTRUCTIVE_ROOT };
  }
  // The user's home is not a project directory, even when cwd lives inside it.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (typeof home === 'string' && home !== '' && resolvedKey === canon(home)) {
    return { risk: RISK.IRREVERSIBLE, reason: REASON.DESTRUCTIVE_ROOT };
  }
  // An ancestor of cwd (e.g. `rm -rf ..`) takes the whole project with it.
  if (isWithin(resolved, ctx.cwd) && !isWithin(ctx.cwd, resolved)) {
    return { risk: RISK.IRREVERSIBLE, reason: REASON.DESTRUCTIVE_ROOT };
  }
  if (isProtected(resolved, ctx.protectedPaths)) return { risk: RISK.IRREVERSIBLE, reason: REASON.PROTECTED_PATH };
  if (!isWithin(ctx.cwd, resolved)) return { risk: RISK.BROAD, reason: REASON.OUTSIDE_SCOPE };
  return { risk: RISK.SCOPED, reason: kind === 'delete' ? REASON.SCOPED_DELETE : REASON.SCOPED_WRITE };
}

function analyzeRedirects(redirects, ctx) {
  let risk = RISK.NONE;
  let reason = REASON.READ_ONLY;
  for (const r of redirects) {
    if (r.op === '<') continue;
    const t = targetRisk(r.target, ctx, 'write');
    risk = worseRisk(risk, t.risk);
    if (t.risk !== RISK.NONE) reason = t.reason;
  }
  return { risk, reason };
}

function analyzeSegment(seg, ctx) {
  const words = seg.words;
  if (words.length === 0) return { risk: RISK.NONE, reason: REASON.READ_ONLY, cmd: '' };

  const cmd = baseName(words[0]);
  const args = words.slice(1);

  const redirect = analyzeRedirects(seg.redirects, ctx);
  const result = classifyWords(cmd, args, ctx);
  if (redirect.risk === RISK.NONE) return result;
  const risk = worseRisk(result.risk, redirect.risk);
  return risk === result.risk ? result : { risk, reason: redirect.reason, cmd };
}

function classifyWords(cmd, args, ctx) {

  // Nested shell: bash -c "..." / powershell -Command "..."
  if (SHELLS.has(cmd)) {
    if (hasAny(args, ['-encodedcommand', '-enc', '-e']) && cmd !== 'bash' && cmd !== 'sh') {
      return { risk: RISK.UNKNOWN, reason: REASON.ENCODED_COMMAND, cmd };
    }
    const idx = args.findIndex((a) => ['-c', '-command', '--command'].includes(a.toLowerCase()));
    if (idx !== -1 && args[idx + 1] !== undefined) {
      const nested = analyzeCommand(args[idx + 1], ctx);
      return { ...nested, cmd };
    }
    if (args.length === 0 || hasAny(args, ['-i', '-noexit', '--interactive'])) {
      return { risk: RISK.UNKNOWN, reason: REASON.INTERACTIVE_SHELL, cmd };
    }
    return { risk: RISK.UNKNOWN, reason: REASON.UNCLASSIFIED, cmd };
  }

  // Deletion
  if (['rm', 'remove-item', 'ri', 'del', 'erase', 'rmdir', 'rd'].includes(cmd)) {
    const targets = args.filter((a) => !a.startsWith('-') && !/^\/[a-zA-Z]+$/.test(a));
    let risk = RISK.SCOPED;
    let reason = REASON.SCOPED_DELETE;
    if (targets.length === 0) return { risk: RISK.UNKNOWN, reason: REASON.UNCLASSIFIED, cmd };
    for (const t of targets) {
      const r = targetRisk(t, ctx, 'delete');
      risk = worseRisk(risk, r.risk);
      if (r.risk !== RISK.SCOPED) reason = r.reason;
    }
    return { risk, reason, cmd };
  }

  if (['dd', 'mkfs', 'mkfs.ext4', 'format', 'diskpart'].includes(cmd)) {
    return { risk: RISK.IRREVERSIBLE, reason: REASON.DISK_OPERATION, cmd };
  }

  if (cmd === 'reg') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'delete') return { risk: RISK.IRREVERSIBLE, reason: REASON.SYSTEM_MODIFICATION, cmd };
    return { risk: RISK.BROAD, reason: REASON.SYSTEM_MODIFICATION, cmd };
  }

  if (cmd === 'sc') {
    const sub = (args[0] || '').toLowerCase();
    if (['delete', 'stop', 'config'].includes(sub)) {
      return { risk: RISK.IRREVERSIBLE, reason: REASON.SYSTEM_MODIFICATION, cmd };
    }
    return { risk: RISK.BROAD, reason: REASON.SYSTEM_MODIFICATION, cmd };
  }

  if (['schtasks', 'shutdown', 'restart-computer', 'stop-computer'].includes(cmd)) {
    return { risk: RISK.BROAD, reason: REASON.SYSTEM_MODIFICATION, cmd };
  }

  if (['chmod', 'chown', 'icacls'].includes(cmd)) {
    const recursive = hasAny(args, ['-r', '--recursive', '/t']);
    return {
      risk: recursive ? RISK.BROAD : RISK.SCOPED,
      reason: recursive ? REASON.PERMISSION_CHANGE : REASON.SCOPED_WRITE,
      cmd
    };
  }

  if (cmd === 'git') {
    const sub = firstNonFlag(args) || '';
    if (sub === 'reset' && hasAny(args, ['--hard'])) return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
    if (sub === 'clean') return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
    if (sub === 'checkout' && hasAny(args, ['--', '.'])) return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
    if (sub === 'push') {
      const force = hasAny(args, ['--force', '-f', '--force-with-lease']);
      return { risk: RISK.BROAD, reason: force ? REASON.FORCE_PUSH : REASON.PUBLISH, cmd };
    }
    if (READ_ONLY_GIT.has(sub)) return { risk: RISK.NONE, reason: REASON.READ_ONLY, cmd };
    if (sub === 'branch') {
      const writes = hasAny(args, ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '--set-upstream-to', '-u', '--unset-upstream']);
      if (!writes) return { risk: RISK.NONE, reason: REASON.READ_ONLY, cmd };
      return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
    }
    if (sub === 'remote' || sub === 'tag' || sub === 'config') {
      const writes = hasAny(args, ['-d', '--delete', '-a', '--add', '--set', '--unset', '--edit', 'remove', 'add', 'set-url']);
      if (!writes) return { risk: RISK.NONE, reason: REASON.READ_ONLY, cmd };
      return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
    }
    if (sub === 'add' || sub === 'commit') return { risk: RISK.SCOPED, reason: REASON.SCOPED_WRITE, cmd };
    if (['merge', 'rebase', 'cherry-pick', 'stash'].includes(sub)) {
      return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
    }
    return { risk: RISK.UNKNOWN, reason: REASON.UNCLASSIFIED, cmd };
  }

  if (['npm', 'pnpm', 'yarn'].includes(cmd)) {
    const sub = firstNonFlag(args) || '';
    if (sub === 'publish') return { risk: RISK.BROAD, reason: REASON.PUBLISH, cmd };
    if (['install', 'i', 'add'].includes(sub)) {
      const global = hasAny(args, ['-g', '--global']);
      return { risk: global ? RISK.BROAD : RISK.SCOPED, reason: global ? REASON.OUTSIDE_SCOPE : REASON.SCOPED_WRITE, cmd };
    }
    if (['run', 'test', 'ci', 'start', 'build'].includes(sub)) {
      return { risk: RISK.SCOPED, reason: REASON.BUILD_SCRIPT, cmd };
    }
    if (['ls', 'list', 'view', '--version'].includes(sub)) return { risk: RISK.NONE, reason: REASON.READ_ONLY, cmd };
    return { risk: RISK.UNKNOWN, reason: REASON.UNCLASSIFIED, cmd };
  }

  if (['node', 'python', 'python3', 'py', 'ruby', 'perl', 'php'].includes(cmd)) {
    if (hasAny(args, ['-e', '--eval', '-p', '--print'])) {
      return { risk: RISK.UNKNOWN, reason: REASON.DYNAMIC_EXECUTION, cmd };
    }
    if (args.length === 0 || hasAny(args, ['-i', '--interactive'])) {
      return { risk: RISK.UNKNOWN, reason: REASON.INTERACTIVE_SHELL, cmd };
    }
    return { risk: RISK.SCOPED, reason: REASON.BUILD_SCRIPT, cmd };
  }

  if (cmd === 'find' && hasAny(args, ['-delete', '-exec'])) {
    return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
  }
  if (cmd === 'xargs' && args.some((a) => ['rm', 'remove-item', 'del'].includes(baseName(a)))) {
    return { risk: RISK.BROAD, reason: REASON.GIT_DESTRUCTIVE, cmd };
  }

  if (['iex', 'invoke-expression'].includes(cmd)) {
    return { risk: RISK.BROAD, reason: REASON.DYNAMIC_EXECUTION, cmd };
  }
  if (cmd === 'eval') return { risk: RISK.UNKNOWN, reason: REASON.DYNAMIC_EXECUTION, cmd };

  if (args.length > 0 && args.every((a) => ['--version', '-v', '--help', '-h', 'help'].includes(a))) {
    return { risk: RISK.NONE, reason: REASON.READ_ONLY, cmd };
  }

  if (READ_ONLY_BASH.has(cmd)) return { risk: RISK.NONE, reason: REASON.READ_ONLY, cmd };

  if (['curl', 'wget', 'invoke-webrequest', 'iwr'].includes(cmd)) {
    return { risk: RISK.BROAD, reason: REASON.REMOTE_FETCH_EXEC, cmd };
  }

  return { risk: RISK.UNKNOWN, reason: REASON.UNCLASSIFIED, cmd };
}

/**
 * Verbs whose missing operand changes the meaning of the command instead of
 * failing loudly. `Remove-Item -Recurse -Force` with no path is the canonical
 * case: the shell may act on the current directory, so "it will error out"
 * is not a safety property.
 */
const OPERAND_REQUIRED = new Set([
  'remove-item', 'ri', 'del', 'erase', 'rm', 'rmdir', 'rd',
  'move-item', 'mv', 'copy-item', 'cp', 'cpi',
  'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc',
  'out-file', 'new-item', 'ni', 'mkdir', 'md', 'rename-item', 'rni'
]);
const VALUE_FLAGS = /^-(path|literalpath|destination|source|value|filter|include|exclude|name|newname)$/i;

/**
 * Static shape check: the command must be well-formed and every mutating verb
 * must carry a concrete operand. Returns a reason code or null.
 */
export function syntaxVerdict(command) {
  const text = String(command ?? '');
  const parsed = lex(text);
  // Unbalanced quotes/brackets: the lexer already knows, and the shell's
  // "recovery" behaviour is exactly what we cannot model.
  if (!parsed.ok) return REASON.MALFORMED_COMMAND;
  // A dangling operator (`Get-ChildItem |`) means the missing operand is a
  // whole command, not a path.
  if (/(\||;|&&|\|\||`)\s*$/.test(text.trim())) return REASON.MALFORMED_COMMAND;

  for (const seg of parsed.segments) {
    const words = seg.words;
    if (words.length === 0) continue;
    const cmd = baseName(words[0]);
    if (!OPERAND_REQUIRED.has(cmd)) continue;
    const args = words.slice(1);
    const positional = args.filter((arg) => !arg.startsWith('-') && !/^\/[A-Za-z]+$/.test(arg));
    if (positional.length === 0) return REASON.MALFORMED_COMMAND;
    // `-Path` as the last token: the value is missing.
    if (args.length > 0 && VALUE_FLAGS.test(args[args.length - 1])) return REASON.MALFORMED_COMMAND;
    // `Set-Content -Value hi` (no -Path): the value is being mistaken for the
    // target, so the real write location is unknown.
    const valueAt = args.findIndex((arg) => /^-value$/i.test(arg));
    if (valueAt !== -1 && !args.some((arg) => /^-(path|literalpath)$/i.test(arg))) {
      const withoutValue = args.filter((_, index) => index !== valueAt + 1);
      const remainingPositional = withoutValue.filter((arg) => !arg.startsWith('-'));
      if (remainingPositional.length === 0) return REASON.MALFORMED_COMMAND;
    }
  }
  return null;
}

/** Analyze a full shell command, including pipelines and nested shells. */
export function analyzeCommand(command, ctx) {
  const parsed = lex(command);
  if (!parsed.ok) return { risk: RISK.UNKNOWN, reason: REASON.UNPARSEABLE };
  if (parsed.segments.length === 0) return { risk: RISK.UNKNOWN, reason: REASON.UNPARSEABLE };

  let risk = RISK.NONE;
  let reason = REASON.READ_ONLY;

  for (const seg of parsed.segments) {
    const r = analyzeSegment(seg, ctx);
    const worse = worseRisk(risk, r.risk);
    if (worse !== risk) {
      risk = worse;
      reason = r.reason;
    }
  }

  // curl ... | bash  (pipeline into a shell)
  if (parsed.hasPipe) {
    const first = parsed.segments[0];
    const last = parsed.segments[parsed.segments.length - 1];
    const fetch = first && ['curl', 'wget', 'iwr', 'invoke-webrequest'].includes(baseName(first.words[0]));
    const exec = last && (SHELLS.has(baseName(last.words[0])) || baseName(last.words[0]) === 'iex');
    if (fetch && exec) return { risk: RISK.BROAD, reason: REASON.REMOTE_FETCH_EXEC };
  }

  if (parsed.substitutions > 0 && risk === RISK.NONE) {
    return { risk: RISK.UNKNOWN, reason: REASON.DYNAMIC_EXECUTION };
  }

  return { risk, reason };
}

export function classifyWrite(write, ctx) {
  const resolved = resolveReal(write.path, ctx.cwd);
  const p = canon(resolved);
  const name = p.split('/').pop() || '';

  if (isProtected(resolved, ctx.protectedPaths)) return { risk: RISK.IRREVERSIBLE, reason: REASON.PROTECTED_PATH };
  if (p.includes('/.git/') || name === '.env' || name.startsWith('.env.') || /\.(pem|key|pfx|p12)$/.test(name)) {
    return { risk: RISK.BROAD, reason: REASON.PROTECTED_PATH };
  }
  if (!isWithin(ctx.cwd, resolved)) return { risk: RISK.BROAD, reason: REASON.OUTSIDE_SCOPE };
  return { risk: RISK.SCOPED, reason: REASON.SCOPED_WRITE };
}

/** Risk -> decision. `interactive` means a human can still be asked. */
export function decide(risk, interactive) {
  if (risk === RISK.NONE || risk === RISK.SCOPED) return 'allow';
  if (risk === RISK.IRREVERSIBLE) return 'deny';
  return interactive ? 'ask' : 'deny';
}

export function review(request, ctx, options = {}) {
  const interactive = options.interactive !== false;
  const result = request.tool === 'Write' || request.tool === 'Edit'
    ? classifyWrite(request.write, ctx)
    : analyzeCommand(request.command, ctx);
  return {
    decision: decide(result.risk, interactive),
    risk: result.risk,
    reason_code: result.reason,
    intent_match: null
  };
}

/**
 * Native shell allowlist for the gate. Pure local: no service, no model.
 * Path verification against the install root happens in the gate.
 */
export function nativeShellVerdict(command) {
  const parsed = lex(command);
  if (!parsed.ok || !parsed.simple || parsed.segments.length !== 1) {
    return { allowed: false, reason: REASON.NATIVE_SHELL_DISABLED };
  }
  const words = parsed.segments[0].words;
  if (words.length === 0) return { allowed: false, reason: REASON.NATIVE_SHELL_DISABLED };

  const cmd = baseName(words[0]);
  const isCustoms = cmd === 'customs' || cmd === 'customs-health';

  if (isCustoms && words.length === 1) return { allowed: true, reason: REASON.READ_ONLY };
  if (cmd === 'customs' && words.length === 2 && ['--status', '--help', '-h'].includes(words[1])) {
    return { allowed: true, reason: REASON.READ_ONLY };
  }

  if (SHELLS.has(cmd) && words.length === 2) {
    const inner = baseName(words[1]);
    if (inner === 'customs' || inner === 'customs-health') return { allowed: true, reason: REASON.READ_ONLY };
  }

  return { allowed: false, reason: REASON.NATIVE_SHELL_DISABLED };
}

/**
 * Protected roots for the DSH plugin. Anything here is denied outright, even
 * when the model set `workdir` into it (plan A1).
 */
export function defaultProtectedPaths(env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  const appData = env.APPDATA || '';
  return [`${home}/.ssh`, `${home}/.aws`, appData, 'C:/Windows', 'C:/Program Files']
    .filter((p) => p && p !== '/')
    .map((p) => canon(p));
}

/**
 * Review one PowerShell call for the DSH plugin.
 *
 * @param {object} input
 * @param {string} input.command  raw command text
 * @param {string} [input.cwd]    resolved working directory (already realpath'd by the caller)
 * @param {boolean} [input.denyOnUnknown]  default true
 * @param {string[]} [input.protectedPaths]
 * @returns {{decision:'allow'|'deny', risk:string, reason_code:string, explain:string}}
 */
/**
 * A delete whose target is a drive root (`C:\`, `c:`, `C:/`) or `/`.
 * Matched on the raw command so escaping or a trailing separator cannot hide it.
 */
const DELETER_WORD = /\b(rm|remove-item|ri|del|erase|rmdir|rd)\b/i;
const ROOT_TARGET = /(?:^|[\s"'=])(?:[a-zA-Z]:[\\/]{0,2}|\/)(?=$|[\s"';&|])/;
const ROOT_DELETE = {
  test(command) {
    return DELETER_WORD.test(command) && ROOT_TARGET.test(command);
  }
};

export function reviewPowerShell(input) {  const { command, cwd, denyOnUnknown = true } = input;
  const protectedPaths = input.protectedPaths ?? defaultProtectedPaths();
  const workdir = resolveReal(cwd || process.cwd());

  if (isProtected(workdir, protectedPaths)) {
    return {
      decision: 'deny',
      risk: RISK.IRREVERSIBLE,
      reason_code: REASON.PROTECTED_PATH,
      explain: `工作目录位于受保护路径。${explain(REASON.PROTECTED_PATH)}`
    };
  }

  // Shape first: a command whose operands do not add up cannot be judged at
  // all, and "the shell will error out" is not a safety property.
  const malformed = syntaxVerdict(command);
  if (malformed !== null) {
    return {
      decision: 'deny',
      risk: RISK.IRREVERSIBLE,
      reason_code: malformed,
      explain: explain(malformed)
    };
  }

  const result = analyzeCommand(command, { cwd: workdir, protectedPaths });

  // Last line of defence, before any decision: a delete aimed at a drive root
  // or filesystem root is never a scoped operation, whatever the lexer did with
  // trailing separators. Missing this once let `Remove-Item C:\ -Recurse` pass.
  if (ROOT_DELETE.test(command)) {
    return {
      decision: 'deny',
      risk: RISK.IRREVERSIBLE,
      reason_code: REASON.DESTRUCTIVE_ROOT,
      explain: explain(REASON.DESTRUCTIVE_ROOT)
    };
  }

  let decision;
  if (result.risk === RISK.NONE || result.risk === RISK.SCOPED) decision = 'allow';
  else if (result.risk === RISK.UNKNOWN && denyOnUnknown === false) decision = 'allow';
  else decision = 'deny';

  return {
    decision,
    risk: result.risk,
    reason_code: result.reason,
    explain: explain(result.reason)
  };
}
