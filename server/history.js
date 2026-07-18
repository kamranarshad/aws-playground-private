const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./store');

const MAX_ENTRIES = 50;
const MAX_FIELD_BYTES = 64 * 1024;

function fileFor(functionId) {
  return path.join(dataDir(), 'history', `${functionId}.jsonl`);
}

function capString(s) {
  if (typeof s !== 'string' || Buffer.byteLength(s, 'utf8') <= MAX_FIELD_BYTES) {
    return { value: s, truncated: false };
  }
  const cut = Buffer.from(s, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8');
  return { value: cut, truncated: true };
}

// Oversized structured values are replaced by a truncated JSON-string preview.
function capJson(value) {
  const str = JSON.stringify(value);
  if (str === undefined || Buffer.byteLength(str, 'utf8') <= MAX_FIELD_BYTES) {
    return { value, truncated: false };
  }
  const cut = Buffer.from(str, 'utf8').subarray(0, MAX_FIELD_BYTES).toString('utf8');
  return { value: cut, truncated: true };
}

function list(functionId) {
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
  return out.reverse();
}

function append(functionId, entry) {
  const logs = capString(entry.logs ?? '');
  const event = capJson(entry.event);
  const response = capJson(entry.response);
  const stored = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    handler: entry.handler ?? '',
    event: event.value,
    response: response.value,
    error: entry.error ?? null,
    logs: logs.value,
    report: entry.report ?? null,
    durationMs: entry.durationMs ?? null,
    ok: !!entry.ok,
    truncated: logs.truncated || event.truncated || response.truncated,
  };
  const oldestFirst = list(functionId).reverse();
  oldestFirst.push(stored);
  const keep = oldestFirst.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(fileFor(functionId)), { recursive: true });
  fs.writeFileSync(fileFor(functionId), keep.map(e => JSON.stringify(e)).join('\n') + '\n');
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

module.exports = { append, list, clear, MAX_ENTRIES, MAX_FIELD_BYTES };
