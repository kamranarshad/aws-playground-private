// Runtime constants shared between server and web
const RUNTIMES = ['python', 'node', 'java', 'provided'];

const ALLOWED_KEYS = [
  'name', 'path', 'runtime', 'handler', 'timeoutMs',
  'memoryMb', 'jarPath', 'env', 'envFile', 'buildCommand',
  'localServices', 'savedEvents', 'trigger', 'autoTrace',
];

const DEFAULTS = {
  handler: '',
  timeoutMs: 30000,
  memoryMb: 128,
  jarPath: null,
  env: {},
  envFile: 'auto',
  buildCommand: '',
  localServices: [],
  savedEvents: [],
  trigger: null,
  autoTrace: false,
};

const RESULT_TABS = ['response', 'logs', 'report', 'trace', 'checks', 'history'];

module.exports = {
  RUNTIMES,
  ALLOWED_KEYS,
  DEFAULTS,
  RESULT_TABS,
};
