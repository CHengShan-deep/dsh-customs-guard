/**
 * Live review timeline, shared between the tool path (writer) and the settings
 * route (reader).
 *
 * Why a process-local ring instead of IPC: the renderer only needs the last few
 * entries and a poll every few hundred milliseconds is cheaper than a push
 * channel — and the route already lives in the same process as the tool.
 */

const MAX_ENTRIES = 8;
const entries = new Map();
let nextId = 1;

/** 0 = started, 1 = rules decided, 2 = model started, 3 = finished. */
function touch(entry, phase, status) {
  entry.phase = phase;
  entry.status = status;
  entry.updatedAt = Date.now();
}

export function beginReview({ command, cwd }) {
  const id = nextId++;
  const entry = {
    id,
    command: String(command ?? '').slice(0, 160),
    cwd: String(cwd ?? ''),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'rules',
    status: 'running'
  };
  entries.set(id, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.keys()].sort((a, b) => a - b)[0];
    entries.delete(oldest);
  }
  return id;
}

export function markPhase(id, phase, status) {
  const entry = entries.get(id);
  if (entry === undefined) return;
  touch(entry, phase, status);
}

export function finishReview(id, status, detail) {
  const entry = entries.get(id);
  if (entry === undefined) return;
  touch(entry, 'done', status);
  if (detail !== undefined) entry.detail = String(detail).slice(0, 200);
  entry.finishedAt = entry.updatedAt;
}

export function reviewSnapshot() {
  const all = [...entries.values()].sort((a, b) => b.id - a.id);
  const active = all.filter((entry) => entry.status === 'running');
  const recent = all.filter((entry) => entry.status !== 'running').slice(0, 5);
  const latest = all[0];
  return { active, recent, total: all.length, latest: latest ?? null };
}
