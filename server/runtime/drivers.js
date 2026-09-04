const path = require('path');
const { findVenvPython } = require('./detect');

const HARNESS_DIR = path.join(__dirname, '..', '..', 'harnesses');

/**
 * @typedef {Object} RuntimeDriver
 * @property {(opts: any, harnessArgs: string[], nodeRequireArgs?: string[]) => { cmd: string, args: string[] }} command
 * @property {boolean} [warm]
 */

/** @type {Map<string, RuntimeDriver>} */
const drivers = new Map();

// Register built-in runtime drivers
drivers.set('python', {
  warm: true,
  command: (opts, harnessArgs) => {
    const interp = findVenvPython(opts.dir) || 'python3';
    return { cmd: interp, args: [path.join(HARNESS_DIR, 'python', 'harness.py'), ...harnessArgs] };
  },
});

drivers.set('node', {
  warm: true,
  command: (opts, harnessArgs, nodeRequireArgs = []) => {
    return { cmd: process.execPath, args: ['--experimental-strip-types', ...nodeRequireArgs, path.join(HARNESS_DIR, 'node', 'harness.mjs'), ...harnessArgs] };
  },
});

drivers.set('provided', {
  warm: true,
  command: (opts, harnessArgs) => {
    return { cmd: process.execPath, args: [path.join(HARNESS_DIR, 'provided', 'harness.mjs'), ...harnessArgs] };
  },
});

drivers.set('java', {
  warm: true,
  command: (opts, harnessArgs) => {
    const harnessJar = path.join(HARNESS_DIR, 'java', 'harness.jar');
    const cp = [harnessJar, opts.jarPath].filter(Boolean).join(path.delimiter);
    return { cmd: 'java', args: ['-cp', cp, 'Harness', ...harnessArgs] };
  },
});

function registerRuntimeDriver(name, driver) {
  drivers.set(name, driver);
}

function getRuntimeDriver(name) {
  return drivers.get(name);
}

function listRuntimeDrivers() {
  return Array.from(drivers.keys());
}

module.exports = {
  registerRuntimeDriver,
  getRuntimeDriver,
  listRuntimeDrivers,
  HARNESS_DIR,
};
