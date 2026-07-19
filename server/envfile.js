const fs = require('fs');
const path = require('path');

// Dotenv-style parsing: KEY=VALUE lines, optional `export ` prefix,
// comments and blanks skipped, surrounding matching quotes stripped.
// No interpolation or multiline values.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILE_RE = /^\.env[A-Za-z0-9._-]*$/;

function parse(text) {
  const env = {};
  for (let line of String(text).split('\n')) {
    line = line.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolve(dir, setting) {
  const choice = setting ?? 'auto';
  if (choice === 'none') return {};
  const name = choice === 'auto' ? '.env' : choice;
  if (!FILE_RE.test(name)) return {};
  try {
    return parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return {};
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => FILE_RE.test(name) &&
        fs.statSync(path.join(dir, name)).isFile())
      .sort();
  } catch {
    return [];
  }
}

module.exports = { parse, resolve, list };
