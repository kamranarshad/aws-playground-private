const fs = require('fs');
const path = require('path');
const services = require('./services');

// Per-project playground.json. Re-read fresh on every use, like .env.
// { services: null } means "no file governance" (missing/invalid file);
// callers then fall back to the function's manual localServices.
function read(dir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'playground.json'), 'utf8'));
  } catch {
    return { services: null };
  }
  if (!Array.isArray(parsed?.services)) return { services: null };
  const known = new Set(services.names());
  return { services: parsed.services.filter((s) => known.has(s)) };
}

module.exports = { read };
