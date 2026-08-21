#!/usr/bin/env node
// npm runs `prepare` both for `npm install` inside a checkout and for installs
// from a git URL, which is why this one script covers `git clone && npm
// install` and `npx github:kamranarshad/aws-playground` alike. It is
// deliberately a no-op inside a packed tarball, where web/dist is already
// built and the web/ source is not shipped at all.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { nodeVersionOk, nodeVersionMessage } = require('../server/node-version');

function planPrepare({ root, env }) {
  if (env.AWS_PLAYGROUND_SKIP_WEB_BUILD) {
    return { skip: 'AWS_PLAYGROUND_SKIP_WEB_BUILD is set' };
  }
  if (!fs.existsSync(path.join(root, 'web', 'package.json'))) {
    return { skip: 'no web/ source in this package' };
  }
  return { install: env.CI ? 'ci' : 'install' };
}

function packageManagerBin(env) {
  // nub fills npm_config_user_agent the same way npm does, so an install
  // driven by `nub install` keeps using nub for the nested web/ install
  // instead of silently switching back to npm. Anything unrecognised falls
  // back to npm -- the one manager every contributor has.
  return /^nub\//.test(env.npm_config_user_agent || '') ? 'nub' : 'npm';
}

function run(bin, args, cwd) {
  const res = spawnSync(bin, args, {
    cwd, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`aws-playground: \`${bin} ${args.join(' ')}\` failed in ${cwd}`);
    process.exit(res.status || 1);
  }
}

function main() {
  const root = path.join(__dirname, '..');
  const plan = planPrepare({ root, env: process.env });
  if (plan.skip) {
    console.error(`aws-playground: skipping web build (${plan.skip})`);
    return;
  }
  if (!nodeVersionOk(process.version)) {
    console.error(nodeVersionMessage(process.version));
    process.exit(1);
  }
  const web = path.join(root, 'web');
  const bin = packageManagerBin(process.env);
  run(bin, [plan.install], web);
  run(bin, ['run', 'build'], web);
}

if (require.main === module) main();

module.exports = { planPrepare, packageManagerBin };
