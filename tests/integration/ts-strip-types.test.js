const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const invoker = require('../../server/runtime/invoker');

test('zero-build TypeScript handler executes directly via Node 22 strip-types', async (t) => {
  t.after(() => require('../../server/runtime/pool').shutdown());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-ts-test-'));
  const tsCode = `
interface Payload {
  name: string;
  count: number;
}

interface Result {
  received: string;
  doubled: number;
}

export const handler = async (event: Payload): Promise<Result> => {
  const received: string = event.name.toUpperCase();
  const doubled: number = event.count * 2;
  return { received, doubled };
};
`;
  fs.writeFileSync(path.join(dir, 'index.ts'), tsCode);

  const res = await invoker.invoke({
    runtime: 'node',
    dir,
    handler: 'index.handler',
    event: { name: 'antigravity', count: 21 },
    timeoutMs: 5000,
    memoryMb: 128,
  });

  assert.strictEqual(res.ok, true, `Invoke failed: ${JSON.stringify(res.error)}`);
  assert.deepStrictEqual(res.response, {
    received: 'ANTIGRAVITY',
    doubled: 42,
  });
});
