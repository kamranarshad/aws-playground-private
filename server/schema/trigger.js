const TRIGGER_TYPES = ['sqs', 'http', 'dynamodb', 's3'];
const S3_EVENTS = ['ObjectCreated', 'ObjectRemoved'];

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Strict: returns a message explaining the rejection, for a UI submission the
// user can correct. null means valid.
function validateTrigger(trigger) {
  if (trigger === null || trigger === undefined) return null;
  if (!TRIGGER_TYPES.includes(trigger.type)) {
    return `unsupported trigger type '${trigger.type}'`;
  }
  if (trigger.type === 'sqs' && !nonEmptyString(trigger.queueName)) {
    return 'trigger.queueName is required';
  }
  if (trigger.type === 'dynamodb' && !nonEmptyString(trigger.tableName)) {
    return 'trigger.tableName is required';
  }
  if (trigger.type === 's3') {
    if (!nonEmptyString(trigger.bucket)) return 'trigger.bucket is required';
    if (!Array.isArray(trigger.events) || trigger.events.length === 0
      || !trigger.events.every((e) => S3_EVENTS.includes(e))) {
      return "trigger.events must be a non-empty array of 'ObjectCreated'/'ObjectRemoved'";
    }
    // Normalized in place (this object is the one that goes on to the store):
    // a repeated event means nothing extra, and a stored duplicate would make
    // a real events-list change look unchanged to the trigger manager's
    // route comparison, silently skipping the reconfigure.
    trigger.events = [...new Set(trigger.events)];
    if (trigger.prefix !== undefined && typeof trigger.prefix !== 'string') return 'trigger.prefix must be a string';
    if (trigger.suffix !== undefined && typeof trigger.suffix !== 'string') return 'trigger.suffix must be a string';
  }
  if (typeof trigger.enabled !== 'boolean') return 'trigger.enabled must be a boolean';
  return null;
}

// Lenient: returns a normalized trigger or null, never a message. A
// playground.json is a file the user edits by hand outside the UI, so an
// invalid value there falls back to the function's manual configuration
// rather than bricking it with an error nobody sees. Declaring a trigger in
// the file IS opting in, so `enabled` is always true regardless of the file.
function coerceTrigger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'http') return { type: 'http', enabled: true };
  if (raw.type === 'sqs') {
    return nonEmptyString(raw.queueName)
      ? { type: 'sqs', queueName: raw.queueName.trim(), enabled: true } : null;
  }
  if (raw.type === 'dynamodb') {
    return nonEmptyString(raw.tableName)
      ? { type: 'dynamodb', tableName: raw.tableName.trim(), enabled: true } : null;
  }
  if (raw.type === 's3') {
    if (!nonEmptyString(raw.bucket)) return null;
    // Deduped as well as filtered, for the same route-comparison reason
    // validateTrigger dedupes.
    const events = Array.isArray(raw.events)
      ? [...new Set(raw.events.filter((e) => S3_EVENTS.includes(e)))] : [];
    if (events.length === 0) return null;
    const trigger = { type: 's3', bucket: raw.bucket.trim(), events, enabled: true };
    if (nonEmptyString(raw.prefix)) trigger.prefix = raw.prefix.trim();
    if (nonEmptyString(raw.suffix)) trigger.suffix = raw.suffix.trim();
    return trigger;
  }
  return null;
}

module.exports = { TRIGGER_TYPES, S3_EVENTS, validateTrigger, coerceTrigger };
