// The playground itself needs a modern Node. `engines` is only advisory unless
// npm is configured for engine-strict, and it does not apply at all once the
// package is on disk, so bin/cli.js and scripts/prepare.js both check here.
const MIN_NODE = '22.12.0';

function segments(version) {
  return String(version).replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
}

function nodeVersionOk(version) {
  const have = segments(version);
  const min = segments(MIN_NODE);
  if (Number.isNaN(have[0])) return false;
  for (let i = 0; i < min.length; i++) {
    const seg = Number.isNaN(have[i]) || have[i] === undefined ? 0 : have[i];
    if (seg > min[i]) return true;
    if (seg < min[i]) return false;
  }
  return true;
}

function nodeVersionMessage(version) {
  return `aws-playground needs Node >= ${MIN_NODE} - this is ${version}. `
    + 'Install a newer Node from https://nodejs.org/';
}

module.exports = { MIN_NODE, nodeVersionOk, nodeVersionMessage };
