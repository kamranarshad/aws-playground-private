const fs = require('fs');
const path = require('path');

// True when the project already sets up its own tracer provider -- checked
// against dependencies AND devDependencies, since either one means "this
// project has its own OTel SDK wiring," not just the API package (which
// alone configures nothing).
function hasOwnTracingSetup(projectDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.keys(deps).some((name) =>
    name.startsWith('@opentelemetry/sdk-trace') || name === '@opentelemetry/sdk-node');
}

module.exports = { hasOwnTracingSetup };
