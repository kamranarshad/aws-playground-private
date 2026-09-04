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

// `web` is a workspace of the root package, so a plain `npm install` at the
// root has already installed its dependencies (hoisted into the root
// node_modules). Re-running an install inside web/ would duplicate all of
// them into a nested tree for no benefit, so this only decides whether the
// deps still need fetching at all -- which they do only when the root install
// was skipped, e.g. a tarball with no web/ source.
function planPrepare({ root, env }) {
  if (env.AWS_PLAYGROUND_SKIP_WEB_BUILD) {
    return { skip: 'AWS_PLAYGROUND_SKIP_WEB_BUILD is set' };
  }
  if (!fs.existsSync(path.join(root, 'web', 'package.json'))) {
    return { skip: 'no web/ source in this package' };
  }
  if (isWorkspaceInstall(root)) return { install: null };
  return { install: env.CI ? 'ci' : 'install' };
}

// Vite resolvable from web/ means the root workspace install already ran.
function isWorkspaceInstall(root) {
  try {
    require.resolve('vite', { paths: [path.join(root, 'web')] });
    return true;
  } catch {
    return false;
  }
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
  // Destructured only to drop it; the underscore marks it as deliberately unused.
  const { npm_config_omit: _omitted, ...env } = process.env;
  const res = spawnSync('npm', args, {
    cwd, env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`aws-playground: \`npm ${args.join(' ')}\` failed in ${cwd}`);
    process.exit(res.status || 1);
  }
}

// The harness jar ships in the npm tarball but is not committed, so a source
// checkout builds it here. A missing JDK is not an error: the Java tests
// already skip without one, and every other runtime still works. Never fatal
// -- exiting here would let a missing JDK block the whole install.
function buildJavaHarness(root) {
  const jar = path.join(root, 'harnesses', 'java', 'harness.jar');
  if (fs.existsSync(jar)) return;
  const build = path.join(root, 'harnesses', 'java', 'build.sh');
  if (!fs.existsSync(build)) return;
  const probe = spawnSync('javac', ['-version'], {
    stdio: 'ignore', shell: process.platform === 'win32',
  });
  if (probe.status !== 0) {
    console.error('aws-playground: no JDK found — skipping the Java harness build. '
      + 'Java functions will be unavailable; every other runtime works.');
    return;
  }
  const res = spawnSync('sh', [build], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('aws-playground: the Java harness build failed — Java functions '
      + 'will be unavailable; every other runtime works.');
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
  if (plan.install) run([plan.install], web);
  run(['run', 'build'], web);
  buildJavaHarness(root);
}

if (require.main === module) main();

module.exports = { planPrepare };
