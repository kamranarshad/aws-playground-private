#!/usr/bin/env node
// Fixtures are sample Lambda projects, each installed on its own and never part
// of the build or the published package. Finding them beats listing them: a
// fixture added later used to be left uninstalled with no sign of it.
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
    console.log('aws-playground: no fixture declares dependencies; nothing to install');
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
  }
}

if (require.main === module) main();

module.exports = { findFixturePackages };
