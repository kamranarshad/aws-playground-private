#!/usr/bin/env node
// Fixtures are sample Lambda projects, each installed on its own and never part
// of the build or the published package. Finding them beats listing them: a
// fixture added later used to be left uninstalled with no sign of it.
// "Found" means the directory has a package.json, not that it declares any
// dependencies worth installing.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findFixturePackages(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const child = path.join(dir, entry.name);
    // A package's own subdirectories are its source, not more fixtures.
    if (fs.existsSync(path.join(child, 'package.json'))) found.push(child);
    else found.push(...findFixturePackages(child));
  }
  return found.sort();
}

function main() {
  const root = path.join(__dirname, '..');
  const fixturesDir = path.join(root, 'fixtures');
  // An installed copy of the package ships scripts/ but not fixtures/ (it is
  // not in package.json's "files"), so this is the normal case there, not an
  // error.
  const dirs = fs.existsSync(fixturesDir) ? findFixturePackages(fixturesDir) : [];
  if (!dirs.length) {
    console.log('aws-playground: no fixture packages found; nothing to install');
    return;
  }
  for (const dir of dirs) {
    console.log(`\naws-playground: installing ${path.relative(root, dir)}`);
    const res = spawnSync('npm', ['install'], {
      cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (res.status !== 0) {
      const reason = res.error ? res.error.message : `exit code ${res.status}`;
      console.error(`aws-playground: \`npm install\` failed in ${dir} (${reason})`);
      process.exit(res.status || 1);
    }
    buildFixture(root, dir);
  }
  buildJavaFixtures(root);
}

// The bundled dist/ output is no longer committed, so a fixture that declares
// a build script has to run it here -- otherwise the tests that load
// dist/index.js silently skip on a fresh clone, which reads as "passing".
function buildFixture(root, dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  if (!pkg.scripts?.build) return;
  console.log(`aws-playground: building ${path.relative(root, dir)}`);
  const res = spawnSync('npm', ['run', 'build'], {
    cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`aws-playground: \`npm run build\` failed in ${dir}`);
    process.exit(res.status || 1);
  }
}

// Java fixtures build through their own build.sh rather than npm. A missing
// JDK is not fatal here for the same reason it is not in scripts/prepare.js:
// the Java tests already skip without one.
function buildJavaFixtures(root) {
  const javaDir = path.join(root, 'fixtures', 'java');
  if (!fs.existsSync(javaDir)) return;
  const probe = spawnSync('javac', ['-version'], {
    stdio: 'ignore', shell: process.platform === 'win32',
  });
  if (probe.status !== 0) {
    console.error('aws-playground: no JDK found — skipping the Java fixture builds.');
    return;
  }
  for (const entry of fs.readdirSync(javaDir, { withFileTypes: true })) {
    const build = path.join(javaDir, entry.name, 'build.sh');
    if (!entry.isDirectory() || !fs.existsSync(build)) continue;
    console.log(`aws-playground: building fixtures/java/${entry.name}`);
    const res = spawnSync('sh', [build], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`aws-playground: the fixtures/java/${entry.name} build failed.`);
    }
  }
}

if (require.main === module) main();

module.exports = { findFixturePackages };
