// AWS SDK clients and the OTel auto-instrumentation stack ship as
// optionalDependencies (see package.json) -- most installs never touch a
// docker-backed trigger or the auto-trace toggle, so there's no reason to
// force everyone to download them. A plain require() of one of these when
// it wasn't installed throws a bare MODULE_NOT_FOUND that reads like an
// internal crash; this turns that into a message naming the exact package
// and the `npm i` that fixes it.
function requireOptional(moduleName, message) {
  try {
    return require(moduleName);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(`'${moduleName}'`)) {
      throw new Error(message);
    }
    throw err;
  }
}

module.exports = { requireOptional };
