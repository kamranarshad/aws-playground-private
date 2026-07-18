const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_KEYS = ['name', 'path', 'runtime', 'handler', 'timeoutMs',
  'memoryMb', 'jarPath', 'env', 'savedEvents'];

function dataDir() {
  return process.env.AWS_PLAYGROUND_DATA_DIR || path.join(os.homedir(), '.aws-playground');
}

function dataFile() {
  return path.join(dataDir(), 'functions.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return { functions: [] };
  }
}

function save(db) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(dataFile(), JSON.stringify(db, null, 2));
}

function list() {
  return load().functions;
}

function get(id) {
  return list().find(f => f.id === id) || null;
}

function create(input) {
  const db = load();
  const fn = {
    id: crypto.randomUUID(),
    name: input.name,
    path: input.path,
    runtime: input.runtime,
    handler: input.handler ?? '',
    timeoutMs: input.timeoutMs ?? 30000,
    memoryMb: input.memoryMb ?? 128,
    jarPath: input.jarPath ?? null,
    env: input.env ?? {},
    savedEvents: input.savedEvents ?? [],
  };
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
