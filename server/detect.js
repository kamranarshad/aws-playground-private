const fs = require('fs');
const path = require('path');
const envfile = require('./envfile');
const projectconfig = require('./projectconfig');

function findVenvPython(dir) {
  for (const v of ['venv', '.venv', 'env']) {
    for (const rel of [path.join(v, 'bin', 'python'), path.join(v, 'Scripts', 'python.exe')]) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findJar(dir) {
  for (const sub of ['target', path.join('build', 'libs')]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch {
      continue; // unreadable target/build dir — skip it, don't blow up detection
    }
    const jars = entries.filter(f =>
      f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
    if (jars.length) return path.join(d, jars.sort()[0]);
  }
  return null;
}

// Reads a file's contents, skipping (returning null) anything that isn't a
// plain readable file — e.g. a directory that happens to share the
// extension we're scanning for, or a file we lack permission to read.
function tryReadFile(full) {
  try {
    if (!fs.statSync(full).isFile()) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

function pythonHandlerCandidates(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.py')) continue;
    const src = tryReadFile(path.join(dir, f));
    if (src === null) continue;
    for (const m of src.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(\s*event\s*,\s*context\b/gm)) {
      out.push(`${f.slice(0, -3)}.${m[1]}`);
    }
  }
  return out;
}

function nodeHandlerCandidates(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(m?js|cjs)$/.test(f)) continue;
    const src = tryReadFile(path.join(dir, f));
    if (src === null) continue;
    const base = f.replace(/\.(m?js|cjs)$/, '');
    const re = /(?:exports\.([A-Za-z_]\w*)\s*=|export\s+(?:const|async\s+function|function)\s+([A-Za-z_]\w*))/g;
    for (const m of src.matchAll(re)) out.push(`${base}.${m[1] || m[2]}`);
  }
  return out;
}

function isExecutableFile(full) {
  try {
    fs.accessSync(full, fs.constants.X_OK);
    return fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

// OS-only (custom runtime) projects: the bootstrap executable plus any
// executable shell scripts are plausible entry points.
function providedHandlerCandidates(dir, files) {
  return files
    .filter(f => f === 'bootstrap' || f.endsWith('.sh'))
    .filter(f => isExecutableFile(path.join(dir, f)))
    .sort();
}

// TypeScript sources at the project root or under src/ (the two layouts
// tsc's rootDir conventions produce flat output for).
function tsSourceFiles(dir) {
  const out = [];
  for (const sub of ['', 'src']) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, sub));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (/\.(m?ts|cts)$/.test(f) && !f.endsWith('.d.ts')) out.push({ sub, name: f });
    }
  }
  return out;
}

function tsOutDir(dir) {
  const raw = tryReadFile(path.join(dir, 'tsconfig.json'));
  if (raw === null) return null;
  let outDir = null;
  try {
    outDir = JSON.parse(raw)?.compilerOptions?.outDir ?? null;
  } catch {
    // tsconfig allows comments/trailing commas; fall back to a regex scan
    const m = raw.match(/"outDir"\s*:\s*"([^"]+)"/);
    outDir = m ? m[1] : null;
  }
  if (!outDir) return null;
  return outDir.replace(/^\.\//, '').replace(/\/+$/, '') || null;
}

function tsHandlerCandidates(dir, tsFiles) {
  const outDir = tsOutDir(dir);
  const prefix = outDir ? `${outDir}/` : '';
  const out = [];
  const re = /(?:exports\.([A-Za-z_]\w*)\s*=|export\s+(?:const|async\s+function|function)\s+([A-Za-z_]\w*))/g;
  for (const { sub, name } of tsFiles) {
    const src = tryReadFile(path.join(dir, sub, name));
    if (src === null) continue;
    const base = name.replace(/\.(m?ts|cts)$/, '');
    for (const m of src.matchAll(re)) out.push(`${prefix}${base}.${m[1] || m[2]}`);
  }
  return out;
}

function detectProject(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { error: 'not-a-directory' };
  }
  const venvPython = findVenvPython(dir);
  const jarPath = findJar(dir);
  const files = fs.readdirSync(dir);
  const tsFiles = tsSourceFiles(dir);
  let runtime = null;
  if (isExecutableFile(path.join(dir, 'bootstrap'))) runtime = 'provided';
  else if (files.some(f => f.endsWith('.py'))) runtime = 'python';
  else if (files.some(f => /\.(m?js|cjs)$/.test(f)) || files.includes('package.json') ||
    tsFiles.length > 0) runtime = 'node';
  else if (jarPath || files.includes('pom.xml') || files.includes('build.gradle')) runtime = 'java';
  const handlerCandidates =
    runtime === 'python' ? pythonHandlerCandidates(dir) :
    runtime === 'provided' ? providedHandlerCandidates(dir, files) :
    runtime === 'node'
      ? [...new Set([...nodeHandlerCandidates(dir), ...tsHandlerCandidates(dir, tsFiles)])]
      : [];
  // Only suggest a build command the project can actually run: without
  // node_modules the toolchain (tsc etc.) isn't installed and `npm run
  // build` is guaranteed to fail — projects are assumed ready to run.
  let buildCommand = null;
  if (tsFiles.length > 0 && fs.existsSync(path.join(dir, 'node_modules'))) {
    const pkg = tryReadFile(path.join(dir, 'package.json'));
    try {
      if (pkg !== null && JSON.parse(pkg)?.scripts?.build) buildCommand = 'npm run build';
    } catch {}
  }
  const projectConfig = projectconfig.read(dir);
  return { runtime, handlerCandidates, venvPython, jarPath,
    envFiles: envfile.list(dir), buildCommand,
    projectServices: projectConfig.services,
    projectTrigger: projectConfig.trigger };
}

module.exports = { detectProject, findVenvPython, findJar };
