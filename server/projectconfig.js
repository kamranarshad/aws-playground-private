const fs = require('fs');
const path = require('path');
const services = require('./services');

function parseTrigger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'sqs') {
    return typeof raw.queueName === 'string' && raw.queueName.trim()
      ? { type: 'sqs', queueName: raw.queueName.trim(), enabled: true }
      : null;
  }
  if (raw.type === 'http') return { type: 'http', enabled: true };
  if (raw.type === 's3') {
    if (typeof raw.bucket !== 'string' || !raw.bucket.trim()) return null;
    // Deduped as well as filtered: a repeated event means nothing extra, and
    // a duplicate would make a real events-list change look unchanged to the
    // trigger manager's route comparison.
    const events = Array.isArray(raw.events)
      ? [...new Set(raw.events.filter((e) => e === 'ObjectCreated' || e === 'ObjectRemoved'))]
      : [];
    if (events.length === 0) return null;
    const trigger = { type: 's3', bucket: raw.bucket.trim(), events, enabled: true };
    if (typeof raw.prefix === 'string' && raw.prefix.trim()) trigger.prefix = raw.prefix.trim();
    if (typeof raw.suffix === 'string' && raw.suffix.trim()) trigger.suffix = raw.suffix.trim();
    return trigger;
  }
  return null;
}

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
    trigger: parseTrigger(parsed?.trigger),
  };
}

module.exports = { read };
