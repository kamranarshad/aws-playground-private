const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./store');
const { writeFileAtomic } = require('./atomic-write');

const MAX_ENTRIES = 50;
const MAX_FIELD_BYTES = 64 * 1024;

// Appends are unbounded between reads, so a session that never opens the
// History tab would grow the file forever. This is the backstop: one stat
// per append (no parse), compacting only when the file is genuinely large.
const COMPACT_BYTES = 4 * 1024 * 1024;

function compactBytes() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_HISTORY_COMPACT_BYTES, 10);
  return Number.isFinite(parsed) ? parsed : COMPACT_BYTES;
}

function fileFor(functionId) {
  return path.join(dataDir(), 'history', `${functionId}.jsonl`);
}

function capString(s) {
  if (typeof s !== 'string' || Buffer.byteLength(s, 'utf8') <= MAX_FIELD_BYTES) {
    return { value: s, truncated: false };
  }
  let cut = Buffer.from(s, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8');
  while (Buffer.byteLength(cut, 'utf8') > MAX_FIELD_BYTES) cut = cut.slice(0, -1);
  return { value: cut, truncated: true };
}

// Oversized structured values are replaced by a truncated JSON-string preview.
function capJson(value) {
  const str = JSON.stringify(value);
  if (str === undefined || Buffer.byteLength(str, 'utf8') <= MAX_FIELD_BYTES) {
    return { value, truncated: false };
  }
  let cut = Buffer.from(str, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8');
  while (Buffer.byteLength(cut, 'utf8') > MAX_FIELD_BYTES) cut = cut.slice(0, -1);
  return { value: cut, truncated: true };
}

// Everything on disk, oldest first. May exceed MAX_ENTRIES: appends are
// append-only and trimming happens here, on the read side.
function readAll(functionId) {
  let raw;
  try {
    raw = fs.readFileSync(fileFor(functionId), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function writeAll(functionId, oldestFirst) {
  writeFileAtomic(fileFor(functionId), oldestFirst.map(e => JSON.stringify(e)).join('\n') + '\n');
}

const { getDb } = require('./sqlite');

/**
 * @param {string} functionId
 * @param {{ limit?: number, offset?: number }} [opts]
 */
function list(functionId, opts) {
  const limit = (opts && typeof opts.limit === 'number') ? opts.limit : MAX_ENTRIES;
  const offset = (opts && typeof opts.offset === 'number') ? opts.offset : 0;

  // Preserve disk compaction contract: if file exists and exceeds cap, compact it
  const all = readAll(functionId);
  if (all.length > MAX_ENTRIES) {
    const keep = all.slice(-MAX_ENTRIES);
    try { writeAll(functionId, keep); } catch {}
  }

  try {
    const sqlite = getDb(dataDir());
    const rows = sqlite.prepare('SELECT data FROM history WHERE function_id = ? ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(functionId, limit, offset);
    if (rows && rows.length > 0) {
      return rows.map(r => JSON.parse(String(r.data)));
    }
  } catch {}

  if (!all.length) return [];

  // Backfill SQLite if file exists but SQLite has no records yet
  try {
    const sqlite = getDb(dataDir());
    const insert = sqlite.prepare('INSERT OR IGNORE INTO history (id, function_id, request_id, ts, duration_ms, ok, error_type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of all) {
      insert.run(e.id || crypto.randomUUID(), functionId, e.report?.requestId ?? null, e.ts || Date.now(), e.durationMs ?? null, e.ok ? 1 : 0, e.error?.type ?? null, JSON.stringify(e));
    }
  } catch {}

  const result = all.length <= MAX_ENTRIES ? all.reverse() : all.slice(-MAX_ENTRIES).reverse();
  return result.slice(offset, offset + limit);
}

function append(functionId, entry) {
  const logs = capString(entry.logs ?? '');
  const event = capJson(entry.event);
  const response = capJson(entry.response);
  const report = capJson(entry.report ?? null);
  const trace = capJson(entry.trace ?? null);
  const stored = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    handler: entry.handler ?? '',
    source: entry.source ?? { type: 'manual' },
    event: event.value,
    eventTruncated: event.truncated,
    response: response.value,
    responseTruncated: response.truncated,
    error: entry.error ?? null,
    logs: logs.value,
    report: report.value,
    ...(trace.value !== null ? { trace: trace.value } : {}),
    durationMs: entry.durationMs ?? null,
    ok: !!entry.ok,
    truncated: logs.truncated || event.truncated || response.truncated || report.truncated || trace.truncated,
  };
  const file = fileFor(functionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(stored) + '\n');
  try {
    const sqlite = getDb(dataDir());
    sqlite.prepare('INSERT INTO history (id, function_id, request_id, ts, duration_ms, ok, error_type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        stored.id,
        functionId,
        stored.report?.requestId ?? null,
        stored.ts,
        stored.durationMs ?? null,
        stored.ok ? 1 : 0,
        stored.error?.type ?? null,
        JSON.stringify(stored)
      );
  } catch {}
  try {
    if (fs.statSync(file).size > compactBytes()) {
      writeAll(functionId, readAll(functionId).slice(-MAX_ENTRIES));
    }
  } catch {}
  return stored;
}

function getByRequestId(functionId, requestId) {
  try {
    const sqlite = getDb(dataDir());
    const row = sqlite.prepare('SELECT data FROM history WHERE function_id = ? AND request_id = ?').get(functionId, requestId);
    if (row && row.data) return JSON.parse(String(row.data));
  } catch {}
  return readAll(functionId).find((e) => e.report?.requestId === requestId) ?? null;
}

// Merges late-arriving spans into an already-persisted entry, found by its
// report.requestId (entries aren't otherwise indexed by that field). No-ops
// if the entry isn't found -- e.g. it was trimmed by MAX_ENTRIES compaction
// while the trace window was still open, an edge the window's short default
// (10s) makes unlikely to matter in practice.
function appendSpans(functionId, requestId, spans, pending) {
  if (!functionId) return;
  const all = readAll(functionId);
  const entry = all.find((e) => e.report?.requestId === requestId);
  if (!entry) return;
  const existingSpans = Array.isArray(entry.trace?.spans) ? entry.trace.spans : [];
  const merged = capJson({ spans: existingSpans.concat(spans), pending });
  entry.trace = merged.value;
  entry.truncated = entry.truncated || merged.truncated;
  writeAll(functionId, all);
  try {
    const sqlite = getDb(dataDir());
    sqlite.prepare('UPDATE history SET data = ? WHERE function_id = ? AND request_id = ?')
      .run(JSON.stringify(entry), functionId, requestId);
  } catch {}
}

function clear(functionId) {
  try {
    getDb(dataDir()).prepare('DELETE FROM history WHERE function_id = ?').run(functionId);
  } catch {}
  try {
    fs.rmSync(fileFor(functionId));
    return true;
  } catch {
    return false;
  }
}

function getStats(functionId) {
  try {
    const sqlite = getDb(dataDir());
    /** @type {{ total?: number, successes?: number, failures?: number, avg_duration?: number, min_duration?: number, max_duration?: number } | undefined} */
    const row = sqlite.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS successes,
        COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures,
        AVG(duration_ms) AS avg_duration,
        MIN(duration_ms) AS min_duration,
        MAX(duration_ms) AS max_duration
      FROM history
      WHERE function_id = ?
    `).get(functionId);

    const total = Number(row?.total ?? 0);
    const successes = Number(row?.successes ?? 0);
    const failures = Number(row?.failures ?? 0);
    const avgDuration = row?.avg_duration != null ? Number(row.avg_duration) : null;
    const minDuration = row?.min_duration != null ? Number(row.min_duration) : null;
    const maxDuration = row?.max_duration != null ? Number(row.max_duration) : null;

    if (total === 0) {
      return {
        total: 0,
        successes: 0,
        failures: 0,
        errorRate: 0,
        avgDurationMs: null,
        minDurationMs: null,
        maxDurationMs: null,
        p50DurationMs: null,
        p95DurationMs: null,
        p99DurationMs: null,
      };
    }

    const durations = sqlite.prepare(`
      SELECT duration_ms FROM history
      WHERE function_id = ? AND duration_ms IS NOT NULL
      ORDER BY duration_ms ASC
    `).all(functionId).map(r => Number(r.duration_ms));

    const percentile = (/** @type {number} */ p) => {
      if (!durations.length) return null;
      const idx = Math.min(Math.floor((p / 100) * durations.length), durations.length - 1);
      return durations[idx];
    };

    return {
      total,
      successes,
      failures,
      errorRate: total > 0 ? Number((failures / total).toFixed(4)) : 0,
      avgDurationMs: avgDuration != null ? Number(avgDuration.toFixed(2)) : null,
      minDurationMs: minDuration != null ? Number(minDuration.toFixed(2)) : null,
      maxDurationMs: maxDuration != null ? Number(maxDuration.toFixed(2)) : null,
      p50DurationMs: percentile(50),
      p95DurationMs: percentile(95),
      p99DurationMs: percentile(99),
    };
  } catch {
    return {
      total: 0,
      successes: 0,
      failures: 0,
      errorRate: 0,
      avgDurationMs: null,
      minDurationMs: null,
      maxDurationMs: null,
      p50DurationMs: null,
      p95DurationMs: null,
      p99DurationMs: null,
    };
  }
}

module.exports = { append, list, clear, getByRequestId, appendSpans, getStats, MAX_ENTRIES, MAX_FIELD_BYTES,
  COMPACT_BYTES, compactBytes };
