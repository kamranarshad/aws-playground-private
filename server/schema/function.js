const fs = require('fs');
const { validateTrigger } = require('./trigger');
// Required by path rather than as `@aws-playground/shared`: the workspace
// symlink that makes the bare specifier resolve exists only in a dev
// checkout, not in an installed copy of the published package.
const { RUNTIMES, ALLOWED_KEYS, DEFAULTS } = require('../../shared');

function getSupportedRuntimes() {
  try {
    const { listRuntimeDrivers } = require('../runtime/drivers');
    const drivers = listRuntimeDrivers();
    if (drivers && drivers.length > 0) return drivers;
  } catch {}
  return RUNTIMES;
}

// Shared between create (fields always present) and update (fields present
// only when patched) so a PATCH can't put the store into a state POST would
// have rejected -- e.g. a non-numeric timeoutMs, which downstream clamps
// setTimeout to ~1ms and SIGKILLs every future invoke almost instantly.
// `currentId` is the function's own id on update (excluded from the name
// collision checks below); null on create, where there's no "self" yet.
// `list`/`get` are injected rather than required so this module never depends
// on the store, and so it is testable without a data directory.
function validateFields(fields, { currentId = null, list, get }) {
  const supported = getSupportedRuntimes();
  if ('runtime' in fields && !supported.includes(fields.runtime)) {
    return `unsupported runtime '${fields.runtime}'`;
  }
  if ('path' in fields
    && (!fs.existsSync(fields.path) || !fs.statSync(fields.path).isDirectory())) {
    return `path is not a directory: ${fields.path}`;
  }
  if ('timeoutMs' in fields && !(Number.isFinite(fields.timeoutMs) && fields.timeoutMs > 0)) {
    return 'timeoutMs must be a positive number';
  }
  if ('memoryMb' in fields && !(Number.isFinite(fields.memoryMb) && fields.memoryMb > 0)) {
    return 'memoryMb must be a positive number';
  }
  if ('autoTrace' in fields && typeof fields.autoTrace !== 'boolean') {
    return 'autoTrace must be a boolean';
  }
  // Required for the HTTP trigger's routing-by-name to be unambiguous, but
  // enforced unconditionally (not just when a trigger is involved) -- the
  // simpler, single rule to reason about.
  if ('name' in fields && typeof fields.name === 'string'
    && list().some((f) => f.name === fields.name && f.id !== currentId)) {
    return `a function named '${fields.name}' already exists`;
  }
  if ('trigger' in fields) {
    const triggerErr = validateTrigger(fields.trigger);
    if (triggerErr) return triggerErr;
  }
  // The effective trigger is whatever this patch leaves in place: the new
  // trigger if it's being changed here, otherwise the function's current
  // stored trigger. A name-only rename (no `trigger` in this patch) must
  // still be checked against an already-enabled http trigger, since it can
  // just as easily break routing.
  const effectiveTrigger = 'trigger' in fields ? fields.trigger : (currentId ? get(currentId)?.trigger : null);
  if (effectiveTrigger?.type === 'http' && effectiveTrigger.enabled) {
    // The effective name is whatever this patch leaves in place: the new
    // name if it's being changed here, otherwise the function's current
    // stored name.
    const name = 'name' in fields ? fields.name : (currentId ? get(currentId)?.name : undefined);
    if (typeof name === 'string' && name.includes('/')) {
      return "an HTTP trigger requires a name without '/' characters";
    }
    if (typeof name === 'string' && list().some((f) => f.name === name && f.id !== currentId)) {
      return `a function named '${name}' already exists — rename it before enabling an HTTP trigger`;
    }
  }
  return null;
}

module.exports = { RUNTIMES, ALLOWED_KEYS, DEFAULTS, validateFields };
