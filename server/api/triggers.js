const manager = require('../trigger/manager');

function listTriggerStatus() {
  return { status: 200, body: manager.statusAll() };
}

module.exports = { listTriggerStatus };
