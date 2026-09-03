const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./store');
const { getDb } = require('./sqlite');

// The default list page size. Not a retention limit -- see RETAIN.
const MAX_ENTRIES = 50;
const MAX_FIELD_BYTES = 64 * 1024;

// How many runs per function survive on disk. list() shows MAX_ENTRIES by
// default and paginates over the rest; getStats() aggregates exactly this
// retained set, so the History tab and the stats panel can never describe
// different data. Overridable for operators who want a longer (or shorter)
// window than the default.
const RETAIN = 1000;

function retainLimit() {
  const parsed = parseInt(process.env.AWS_PLAYGROUND_HISTORY_RETAIN, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RETAIN;
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

// --- legacy JSONL import ---------------------------------------------------

// Installs that predate the SQLite consolidation hold their runs in
// history/<functionId>.jsonl. Every read path imports one before answering.
function legacyFile(functionId) {
  return path.join(dataDir(), 'history', `${functionId}.jsonl`);
}

// One existsSync per function per process, rather than per read.
/** @type {Set<string>} */
const importChecked = new Set();

function insertRow(sqlite, functionId, entry, ignoreConflict = false) {
  sqlite.prepare(
    `INSERT ${ignoreConflict ? 'OR IGNORE ' : ''}INTO history `
    + '(id, function_id, request_id, ts, duration_ms, ok, error_type, data) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    entry.id ?? crypto.randomUUID(),
    functionId,
    entry.report?.requestId ?? null,
    entry.ts ?? Date.now(),
    entry.durationMs ?? null,
    entry.ok ? 1 : 0,
    entry.error?.type ?? null,
    JSON.stringify(entry),
  );
}

// Imports history/<id>.jsonl into SQLite, then sets the file aside rather
// than deleting it -- the same instinct store.js applies to a registry it
// cannot parse. Renaming is what makes the import happen exactly once; a
// re-import would be harmless (INSERT OR IGNORE keys on the entry id) but
// would re-read the whole file on every list().
function importLegacy(sqlite, functionId) {
  if (importChecked.has(functionId)) return;
  importChecked.add(functionId);
  const file = legacyFile(functionId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no legacy file, which is the common case
  }
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        insertRow(sqlite, functionId, entry, true);
      }
      sqlite.exec('COMMIT');
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch {}
      throw err;
    }
    trim(sqlite, functionId);
    fs.renameSync(file, `${file}.imported`);
  } catch (err) {
    console.warn(
      `aws-playground: could not import legacy history for ${functionId} `
      + `(${err.message}); ${file} was left in place.`);
  }
}

// Every read and write path goes through here, so a pre-existing install sees
// its runs on the first access, whichever one it happens to be.
function readyDb(functionId) {
  const sqlite = getDb(dataDir());
  importLegacy(sqlite, functionId);
  return sqlite;
}

// --- writes ----------------------------------------------------------------

// Drops everything older than the newest retainLimit() runs. rowid is
// SQLite's insertion counter, so this is exact even when several runs share a
// millisecond ts. The subquery yields no row (and the DELETE matches nothing)
// until the function is actually over the cap, so the hot path pays one
// indexed lookup per invoke, not a scan.
function trim(sqlite, functionId) {
  sqlite.prepare(`
    DELETE FROM history WHERE function_id = ? AND rowid <= (
      SELECT rowid FROM history WHERE function_id = ?
      ORDER BY rowid DESC LIMIT 1 OFFSET ?
    )
  `).run(functionId, functionId, retainLimit());
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
    truncated: logs.truncated || event.truncated || response.truncated
      || report.truncated || trace.truncated,
  };
  const sqlite = readyDb(functionId);
  insertRow(sqlite, functionId, stored);
  trim(sqlite, functionId);
  return stored;
}

// Merges late-arriving spans into an already-persisted run, found by its
// report.requestId. No-ops if the run is not found -- e.g. it aged out past
// retainLimit() while the trace window was still open, an edge the window's
// short default (10s) makes unlikely to matter in practice.
function appendSpans(functionId, requestId, spans, pending) {
  if (!functionId) return;
  try {
    const sqlite = readyDb(functionId);
    const row = sqlite.prepare(
      'SELECT data FROM history WHERE function_id = ? AND request_id = ?')
      .get(functionId, requestId);
    if (!row) return;
    const entry = JSON.parse(String(row.data));
    const existingSpans = Array.isArray(entry.trace?.spans) ? entry.trace.spans : [];
    const merged = capJson({ spans: existingSpans.concat(spans), pending });
    entry.trace = merged.value;
    entry.truncated = entry.truncated || merged.truncated;
    sqlite.prepare('UPDATE history SET data = ? WHERE function_id = ? AND request_id = ?')
      .run(JSON.stringify(entry), functionId, requestId);
  } catch (err) {
    console.warn(`aws-playground: failed to merge trace spans: ${err.message}`);
  }
}

function clear(functionId) {
  const removed = getDb(dataDir())
    .prepare('DELETE FROM history WHERE function_id = ?').run(functionId).changes > 0;
  // A legacy file that was never read would otherwise resurrect, on the next
  // list(), the history the user just cleared.
  let legacyRemoved = false;
  try {
    fs.rmSync(legacyFile(functionId));
    legacyRemoved = true;
  } catch {}
  importChecked.add(functionId);
  return removed || legacyRemoved;
}

// --- reads -----------------------------------------------------------------

/**
 * Newest first.
 * @param {string} functionId
 * @param {{ limit?: number, offset?: number }} [opts]
 */
function list(functionId, opts) {
  const limit = (opts && typeof opts.limit === 'number') ? opts.limit : MAX_ENTRIES;
  const offset = (opts && typeof opts.offset === 'number') ? opts.offset : 0;
  const rows = readyDb(functionId).prepare(
    'SELECT data FROM history WHERE function_id = ? '
    + 'ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?')
    .all(functionId, limit, offset);
  return rows.map((r) => JSON.parse(String(r.data)));
}

function getByRequestId(functionId, requestId) {
  const row = readyDb(functionId).prepare(
    'SELECT data FROM history WHERE function_id = ? AND request_id = ?')
    .get(functionId, requestId);
  return row?.data ? JSON.parse(String(row.data)) : null;
}

const EMPTY_STATS = Object.freeze({
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
});

const round2 = (/** @type {number | null | undefined} */ n) =>
  n != null ? Number(Number(n).toFixed(2)) : null;

function getStats(functionId) {
  const sqlite = readyDb(functionId);
  /** @type {any} */
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
  if (total === 0) return { ...EMPTY_STATS };

  const failures = Number(row?.failures ?? 0);
  const durations = sqlite.prepare(`
    SELECT duration_ms FROM history
    WHERE function_id = ? AND duration_ms IS NOT NULL
    ORDER BY duration_ms ASC
  `).all(functionId).map((r) => Number(r.duration_ms));

  const percentile = (/** @type {number} */ p) => {
    if (!durations.length) return null;
    return durations[Math.min(Math.floor((p / 100) * durations.length), durations.length - 1)];
  };

  return {
    total,
    successes: Number(row?.successes ?? 0),
    failures,
    errorRate: Number((failures / total).toFixed(4)),
    avgDurationMs: round2(row?.avg_duration),
    minDurationMs: round2(row?.min_duration),
    maxDurationMs: round2(row?.max_duration),
    p50DurationMs: percentile(50),
    p95DurationMs: percentile(95),
    p99DurationMs: percentile(99),
  };
}

module.exports = { append, list, clear, getByRequestId, appendSpans, getStats,
  MAX_ENTRIES, MAX_FIELD_BYTES, RETAIN, retainLimit };
