const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');
const { ALLOWED_KEYS, DEFAULTS } = require('../schema');

function dataDir() {
  return process.env.AWS_PLAYGROUND_DATA_DIR || path.join(os.homedir(), '.aws-playground');
}

function dataFile() {
  return path.join(dataDir(), 'functions.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { functions: [] };
    // Registry exists but is unreadable as JSON (corrupted file, partial
    // write, etc). Don't silently discard the user's data: quarantine the
    // bad file so it can be inspected/recovered, then start fresh.
    const corruptFile = dataFile() + '.corrupt';
    try {
      fs.renameSync(dataFile(), corruptFile);
    } catch {
      // best effort — if we can't even rename it, fall through and start fresh
    }
    console.warn(
      `aws-playground: ${dataFile()} could not be read (${err.message}); ` +
      `moved it to ${corruptFile} and starting with an empty function registry.`);
    return { functions: [] };
  }
}

const { getDb } = require('./sqlite');

function save(db) {
  writeFileAtomic(dataFile(), JSON.stringify(db, null, 2));
  try {
    const sqlite = getDb(dataDir());
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const currentIds = new Set(db.functions.map(f => f.id));
      const existingRows = sqlite.prepare('SELECT id FROM functions').all();
      const deleteStmt = sqlite.prepare('DELETE FROM functions WHERE id = ?');
      for (const row of existingRows) {
        if (!currentIds.has(row.id)) {
          deleteStmt.run(row.id);
        }
      }
      const upsert = sqlite.prepare(
        'INSERT INTO functions (id, name, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data'
      );
      for (const fn of db.functions) {
        upsert.run(fn.id, fn.name, JSON.stringify(fn));
      }
      sqlite.exec('COMMIT');
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch {}
      throw err;
    }
  } catch {}
}

function list() {
  return load().functions;
}

function get(id) {
  try {
    const sqlite = getDb(dataDir());
    const row = sqlite.prepare('SELECT data FROM functions WHERE id = ?').get(id);
    if (row && row.data) {
      return JSON.parse(String(row.data));
    }
  } catch {}
  return list().find(f => f.id === id) || null;
}

function create(input) {
  const db = load();
  const fn = { id: crypto.randomUUID(), ...DEFAULTS };
  for (const k of ALLOWED_KEYS) if (input[k] !== undefined) fn[k] = input[k];
  db.functions.push(fn);
  save(db);
  return fn;
}

function update(id, patch) {
  const db = load();
  const fn = db.functions.find(f => f.id === id);
  if (!fn) return null;
  for (const k of ALLOWED_KEYS) if (k in patch) fn[k] = patch[k];
  save(db);
  return fn;
}

function remove(id) {
  const db = load();
  const i = db.functions.findIndex(f => f.id === id);
  if (i === -1) return false;
  db.functions.splice(i, 1);
  save(db);
  return true;
}

module.exports = { dataDir, list, get, create, update, remove };
