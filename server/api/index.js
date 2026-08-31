const { health } = require('./health');
const { RUNTIMES, listFunctions, createFunction, updateFunction, deleteFunction, detect } = require('./functions');
const { invokeFunction } = require('./invoke');
const { listServices, startService, stopService, setSelection } = require('./services');
const { listHistory, clearHistory, getInvokeTrace } = require('./history');
const { listTriggerStatus } = require('./triggers');
const bootstrap = require('../bootstrap');

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, listHistory, clearHistory, getInvokeTrace,
  listServices, startService, stopService, setSelection, listTriggerStatus, RUNTIMES,
  startBootstrap: () => bootstrap.start() };
