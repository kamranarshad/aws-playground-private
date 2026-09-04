// Sample handler with NO OpenTelemetry code at all -- demonstrates
// aws-playground's Node auto-tracing feature: enable "Auto-trace" on this
// function (Node-only functions get the toggle) and this http.get call
// gets a real captured span with zero code changes here. Deliberately
// plain CommonJS (require/exports.handler, no build step) since
// auto-instrumentation patches libraries via CommonJS's require() -- see
// docs/superpowers/specs/2026-08-30-node-auto-tracing-design.md for why
// that's a real constraint, not an arbitrary style choice.
const http = require('http');

exports.handler = async (event) => {
  const url = event.url;
  const body = await new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  return { ok: true, body };
};
