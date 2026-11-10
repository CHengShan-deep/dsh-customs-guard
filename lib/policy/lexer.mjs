/**
 * Small shell lexer. It is deliberately conservative: anything it cannot
 * tokenize safely is reported as a parse failure and the caller must treat
 * the command as unknown.
 */

const TWO_CHAR_OPS = new Set(['&&', '||', ';;', '|&', '>>', '<<']);
const ONE_CHAR_OPS = new Set(['|', '&', ';', '>', '<']);

export function lex(command) {
  const tokens = [];
  let i = 0;
  let parseOk = true;
  let substitutions = 0;
  let cur = null;
  const n = command.length;

  const flush = () => {
    if (cur !== null && cur.value !== '') tokens.push({ type: 'word', value: cur.value });
    cur = null;
  };
  const pushOp = (value) => {
    flush();
    tokens.push({ type: 'op', value });
  };

  while (i < n) {
    const ch = command[i];

    if (ch === "'") {
      cur = cur ?? { value: '' };
      i += 1;
      const end = command.indexOf("'", i);
      if (end === -1) {
        parseOk = false;
        cur.value += command.slice(i);
        i = n;
      } else {
        cur.value += command.slice(i, end);
        i = end + 1;
      }
      continue;
    }

    if (ch === '"') {
      cur = cur ?? { value: '' };
      i += 1;
      let closed = false;
      while (i < n) {
        if (command[i] === '\\' && i + 1 < n) {
          const next = command[i + 1];
          if (/["\\$`]/.test(next)) {
            cur.value += next;
            i += 2;
          } else {
            cur.value += '\\';
            i += 1;
          }
          continue;
        }
        if (command[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (command[i] === '$' && command[i + 1] === '(') {
          substitutions += 1;
          i = skipBalanced(command, i + 2);
          continue;
        }
        cur.value += command[i];
        i += 1;
      }
      if (!closed) parseOk = false;
      continue;
    }

    if (ch === '\\' && i + 1 < n) {
      const next = command[i + 1];
      cur = cur ?? { value: '' };
      if (/[\s"'`$\\|&;<>()]/.test(next)) {
        cur.value += next;
        i += 2;
      } else {
        cur.value += '\\';
        i += 1;
      }
      continue;
    }

    if (ch === '$' && command[i + 1] === '(') {
      substitutions += 1;
      i = skipBalanced(command, i + 2);
      continue;
    }
    if (ch === '`') {
      substitutions += 1;
      const end = command.indexOf('`', i + 1);
      i = end === -1 ? n : end + 1;
      if (end === -1) parseOk = false;
      continue;
    }

    if (ch === '>' && command[i + 1] === '&') {
      pushOp('>');
      i += 3;
      continue;
    }

    if (ch === '\n') {
      pushOp(';');
      i += 1;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      i += 1;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      pushOp(two);
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      pushOp(ch);
      i += 1;
      continue;
    }

    cur = cur ?? { value: '' };
    cur.value += ch;
    i += 1;
  }

  flush();

  const segments = [];
  let seg = { words: [], redirects: [], pending: null };
  for (const token of tokens) {
    if (token.type === 'op') {
      if (token.value === '>' || token.value === '>>' || token.value === '<') {
        seg.pending = token.value;
        continue;
      }
      segments.push(seg);
      seg = { words: [], redirects: [], pending: null };
      continue;
    }
    if (seg.pending !== null) {
      seg.redirects.push({ op: seg.pending, target: token.value });
      seg.pending = null;
      continue;
    }
    seg.words.push(token.value);
  }
  segments.push(seg);

  const nonEmpty = segments.filter((s) => s.words.length > 0 || s.redirects.length > 0);
  return {
    ok: parseOk,
    tokens,
    segments: nonEmpty,
    substitutions,
    hasPipe: tokens.some((t) => t.type === 'op' && (t.value === '|' || t.value === '|&')),
    simple: parseOk && nonEmpty.length === 1 && !nonEmpty[0].redirects.length && substitutions === 0
      && !tokens.some((t) => t.type === 'op')
  };
}

function skipBalanced(command, start) {
  let depth = 1;
  let i = start;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return command.length;
      i = end + 1;
      continue;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') j += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return command.length;
}
