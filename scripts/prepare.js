#!/usr/bin/env node
// npm runs `prepare` both for `npm install` inside a checkout and for installs
// from a git URL, which is why this one script covers `git clone && npm
// install` and `npx github:kamranarshad/aws-playground` alike. It is
// deliberately a no-op inside a packed tarball, where web/dist is already
// built and the web/ source is not shipped at all.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { nodeVersionOk, nodeVersionMessage } = require('../server/runtime/node-version');

function planPrepare({ root, env }) {
  if (env.AWS_PLAYGROUND_SKIP_WEB_BUILD) {
    return { skip: 'AWS_PLAYGROUND_SKIP_WEB_BUILD is set' };
  }
  if (!fs.existsSync(path.join(root, 'web', 'package.json'))) {
    return { skip: 'no web/ source in this package' };
  }
  return { install: env.CI ? 'ci' : 'install' };
}

function run(args, cwd) {
  // npm exports its own flags as npm_config_* env vars for lifecycle scripts,
  // and spawnSync inherits process.env by default -- so `npm install
  // --omit=optional` at the root (skipping the root's optional AWS SDK/OTel
  // packages) would otherwise leak into this nested install for web/ and
  // make IT skip its own, unrelated build-tool optionalDependencies (e.g.
  // rollup's platform-specific native binary), breaking the web build
  // outright. web/'s install is independent of the root's optional-deps
  // choice, so that var is stripped here.
  const { npm_config_omit, ...env } = process.env;
  const res = spawnSync('npm', args, {
    cwd, env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`aws-playground: \`npm ${args.join(' ')}\` failed in ${cwd}`);
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
  run([plan.install], web);
  run(['run', 'build'], web);
}

if (require.main === module) main();

module.exports = { planPrepare };
