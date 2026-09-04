const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

/** @type {DatabaseSync | null} */
let dbInstance = null;
/** @type {string | null} */
let currentDbPath = null;

function getDb(dataDir) {
  const dbPath = path.join(dataDir, 'playground.db');
  if (dbInstance && currentDbPath === dbPath) return dbInstance;
  if (dbInstance) {
    try { dbInstance.close(); } catch {}
  }
  fs.mkdirSync(dataDir, { recursive: true });
  dbInstance = new DatabaseSync(dbPath);
  currentDbPath = dbPath;
  dbInstance.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS functions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_functions_name ON functions (name);

    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      function_id TEXT NOT NULL,
      request_id TEXT,
      ts INTEGER NOT NULL,
      duration_ms REAL,
      ok INTEGER,
      error_type TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_fn ON history (function_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_history_req ON history (function_id, request_id);
    CREATE INDEX IF NOT EXISTS idx_history_duration ON history (function_id, duration_ms);
  `);
  try { dbInstance.exec('ALTER TABLE history ADD COLUMN duration_ms REAL;'); } catch {}
  try { dbInstance.exec('ALTER TABLE history ADD COLUMN ok INTEGER;'); } catch {}
  try { dbInstance.exec('ALTER TABLE history ADD COLUMN error_type TEXT;'); } catch {}
  return dbInstance;
}

function close() {
  if (dbInstance) {
    try { dbInstance.close(); } catch {}
    dbInstance = null;
    currentDbPath = null;
  }
}

module.exports = { getDb, close };
