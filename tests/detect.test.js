const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectProject, findVenvPython, findJar } = require('../server/detect');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-detect-'));
}

test('detects python project with venv and handler candidates', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.py'),
    'def handler(event, context):\n    return {}\n\ndef helper(x):\n    return x\n');
  fs.mkdirSync(path.join(dir, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'venv', 'bin', 'python'), '');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'python');
  assert.deepStrictEqual(res.handlerCandidates, ['app.handler']);
  assert.strictEqual(res.venvPython, path.join(dir, 'venv', 'bin', 'python'));
  assert.strictEqual(res.jarPath, null);
});

test('detects node project and export candidates', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.js'),
    'exports.handler = async (event, context) => ({});\n');
  fs.writeFileSync(path.join(dir, 'other.mjs'),
    'export async function run(event, context) { return {}; }\n');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'node');
  assert.ok(res.handlerCandidates.includes('index.handler'));
  assert.ok(res.handlerCandidates.includes('other.run'));
});

test('detects java project via built jar', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'target'));
  fs.writeFileSync(path.join(dir, 'target', 'app-1.0.jar'), '');
  fs.writeFileSync(path.join(dir, 'target', 'app-1.0-sources.jar'), '');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'java');
  assert.strictEqual(res.jarPath, path.join(dir, 'target', 'app-1.0.jar'));
  assert.strictEqual(findJar(dir), path.join(dir, 'target', 'app-1.0.jar'));
});

test('returns error for a non-directory', () => {
  assert.deepStrictEqual(detectProject('/no/such/dir/xyz'), { error: 'not-a-directory' });
});

test('findVenvPython returns null when absent', () => {
  assert.strictEqual(findVenvPython(tmpDir()), null);
});
