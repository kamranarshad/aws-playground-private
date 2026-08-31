const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectProject, findVenvPython, findJar } = require('../server/runtime/detect');

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

test('skips directory entries named like source files instead of throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.py'),
    'def handler(event, context):\n    return {}\n');
  // A directory literally named "sub.py" — readFileSync on this would throw
  // EISDIR if not guarded.
  fs.mkdirSync(path.join(dir, 'sub.py'));
  let res;
  assert.doesNotThrow(() => { res = detectProject(dir); });
  assert.strictEqual(res.runtime, 'python');
  assert.deepStrictEqual(res.handlerCandidates, ['app.handler']);
});

test('detects typescript project with build script and outDir candidates', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'src.ts'), ''); // any .ts implies node runtime
  fs.rmSync(path.join(dir, 'src.ts'));
  fs.writeFileSync(path.join(dir, 'index.ts'),
    'export const handler = async (event: unknown) => ({ ok: true })\n' +
    'export function helper(x: number): number { return x }\n');
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { build: 'tsc' } }));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { outDir: 'dist', strict: true } }));
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'node');
  assert.strictEqual(res.buildCommand, 'npm run build');
  assert.ok(res.handlerCandidates.includes('dist/index.handler'));
  assert.ok(res.handlerCandidates.includes('dist/index.helper'));
});

test('typescript without build script or outDir: no buildCommand, plain candidates', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const handler = async () => 1\n');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'node');
  assert.strictEqual(res.buildCommand, null);
  assert.ok(res.handlerCandidates.includes('index.handler'));
});

test('js project keeps buildCommand null even with build script', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.js'), 'exports.handler = async () => 1;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'node');
  assert.strictEqual(res.buildCommand, null);
});

test('typescript sources under src/ map candidates through outDir', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'),
    'export const handler = async (event: unknown) => event\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { outDir: './dist', rootDir: 'src' } }));
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'node');
  assert.strictEqual(res.buildCommand, 'npm run build');
  assert.ok(res.handlerCandidates.includes('dist/index.handler'));
});

test('no buildCommand suggestion when node_modules is missing (toolchain not installed)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const handler = async () => 1\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'node');
  assert.strictEqual(res.buildCommand, null);
});

test('bootstrap file detects the provided runtime', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bootstrap'), '#!/bin/bash\n');
  fs.chmodSync(path.join(dir, 'bootstrap'), 0o755);
  fs.writeFileSync(path.join(dir, 'deploy.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, 'deploy.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'notes.sh'), 'not executable');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'provided');
  assert.deepStrictEqual(res.handlerCandidates, ['bootstrap', 'deploy.sh']);
});

test('bootstrap wins over other runtime markers', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bootstrap'), '#!/bin/bash\n');
  fs.chmodSync(path.join(dir, 'bootstrap'), 0o755);
  fs.writeFileSync(path.join(dir, 'app.py'), 'def handler(event, context):\n    return 1\n');
  const res = detectProject(dir);
  assert.strictEqual(res.runtime, 'provided');
});

test('projectTrigger reflects a playground.json-declared trigger', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.py'), 'def handler(event, context):\n    return {}\n');
  fs.writeFileSync(path.join(dir, 'playground.json'), JSON.stringify({ trigger: { type: 'http' } }));
  const res = detectProject(dir);
  assert.deepStrictEqual(res.projectTrigger, { type: 'http', enabled: true });
});

test('projectTrigger is null when playground.json declares none', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.py'), 'def handler(event, context):\n    return {}\n');
  const res = detectProject(dir);
  assert.strictEqual(res.projectTrigger, null);
});
