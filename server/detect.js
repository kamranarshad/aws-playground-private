const fs = require('fs');
const path = require('path');

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
    const jars = fs.readdirSync(d).filter(f =>
      f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
    if (jars.length) return path.join(d, jars.sort()[0]);
  }
  return null;
}

function pythonHandlerCandidates(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.py')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
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
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const base = f.replace(/\.(m?js|cjs)$/, '');
    const re = /(?:exports\.([A-Za-z_]\w*)\s*=|export\s+(?:const|async\s+function|function)\s+([A-Za-z_]\w*))/g;
    for (const m of src.matchAll(re)) out.push(`${base}.${m[1] || m[2]}`);
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
  let runtime = null;
  if (files.some(f => f.endsWith('.py'))) runtime = 'python';
  else if (files.some(f => /\.(m?js|cjs)$/.test(f)) || files.includes('package.json')) runtime = 'node';
  else if (jarPath || files.includes('pom.xml') || files.includes('build.gradle')) runtime = 'java';
  const handlerCandidates =
    runtime === 'python' ? pythonHandlerCandidates(dir) :
    runtime === 'node' ? nodeHandlerCandidates(dir) : [];
  return { runtime, handlerCandidates, venvPython, jarPath };
}

module.exports = { detectProject, findVenvPython, findJar };
