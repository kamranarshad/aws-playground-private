const fs = require('fs');
const path = require('path');
const services = require('./services');
const { coerceTrigger } = require('./schema');

// Per-project playground.json. Re-read fresh on every use, like .env.
// A null `services`/`trigger` means "no file governance" for that key
// (missing file, invalid JSON, or an invalid/absent value) — callers then
// fall back to the function's manual configuration.
function read(dir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'playground.json'), 'utf8'));
  } catch {
    return { services: null, trigger: null };
  }
  const known = new Set(services.names());
  return {
    services: Array.isArray(parsed?.services) ? parsed.services.filter((s) => known.has(s)) : null,
    trigger: coerceTrigger(parsed?.trigger),
  };
}

module.exports = { read };
