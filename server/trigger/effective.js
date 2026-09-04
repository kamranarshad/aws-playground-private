const projectconfig = require('../persistence/projectconfig');

// A function's trigger, resolved the same way effectiveServices resolves
// local services: a playground.json declaration wins outright over
// whatever's manually stored on the function (fn.trigger, written through
// the trigger-button UI). Re-read fresh on every call — never cached —
// since the file can change without the function being re-saved.
function effectiveTrigger(fn) {
  return projectconfig.read(fn.path).trigger ?? fn.trigger ?? null;
}

module.exports = { effectiveTrigger };
