const { health } = require('./health');
const { RUNTIMES, listFunctions, createFunction, updateFunction, deleteFunction, detect } = require('./functions');
const { invokeFunction } = require('./invoke');
const { listServices, startService, stopService, setSelection } = require('./services');
const { listHistory, clearHistory } = require('./history');
const { listTriggerStatus } = require('./triggers');

module.exports = { health, listFunctions, createFunction, updateFunction,
  deleteFunction, detect, invokeFunction, listHistory, clearHistory,
  listServices, startService, stopService, setSelection, listTriggerStatus, RUNTIMES };
