const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./store');

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
  const file = fileFor(functionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, oldestFirst.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function list(functionId) {
  const all = readAll(functionId);
  if (all.length <= MAX_ENTRIES) return all.reverse();
  // The overflow is already parsed here, so compacting costs one write and
  // amortizes across the MAX_ENTRIES appends that produced it.
  const keep = all.slice(-MAX_ENTRIES);
  try { writeAll(functionId, keep); } catch {}
  return keep.reverse();
}

function append(functionId, entry) {
  const logs = capString(entry.logs ?? '');
  const event = capJson(entry.event);
  const response = capJson(entry.response);
  const report = capJson(entry.report ?? null);
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
    durationMs: entry.durationMs ?? null,
    ok: !!entry.ok,
    truncated: logs.truncated || event.truncated || response.truncated || report.truncated,
  };
  const file = fileFor(functionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(stored) + '\n');
  try {
    if (fs.statSync(file).size > compactBytes()) {
      writeAll(functionId, readAll(functionId).slice(-MAX_ENTRIES));
    }
  } catch {}
  return stored;
}

function clear(functionId) {
  try {
    fs.rmSync(fileFor(functionId));
    return true;
  } catch {
    return false;
  }
}

module.exports = { append, list, clear, MAX_ENTRIES, MAX_FIELD_BYTES,
  COMPACT_BYTES, compactBytes };
