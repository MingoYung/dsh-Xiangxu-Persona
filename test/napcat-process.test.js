import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createOwnedQqProcessVerifier } from '../adapters/dsh/connections/napcat-process.js';

const now = Date.now(), start = now - 10000, qqPath = path.resolve('fixture-QQ/QQ.exe');
const row = (pid, parentPid, offset = 1, file = qqPath) => ({ pid, parentPid, path: file, createdAt: new Date(start + offset).toISOString() });
const options = { launcher: { pid: 100 }, qqPath, startedAt: start, bootId: 'test-boot' };
test('QQ native ownership requires the exact QQ executable and owned launcher ancestry', async () => {
  let rows = [row(300, 200, 3), row(200, 100, 2)];
  const calls = [], verify = createOwnedQqProcessVerifier({ platform: 'win32', clock: () => now, execFilePort: async (...args) => { calls.push(args); return { stdout: JSON.stringify(rows) }; } });
  assert.equal(await verify(300, options), true);
  assert.equal(calls[0][2].windowsHide, true);
  assert.match(Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le'), /ProcessId/);
  rows = [row(300, 200, 4), row(200, 100, 2)];
  assert.equal(await verify(300, options), false, 'a reused PID must not inherit ownership');
});
test('QQ native verifier rejects unrelated, older, mismatched and malformed process metadata', async () => {
  for (const rows of [[row(300, 999)], [row(300, 100, -5000)], [row(300, 100, -1)], [row(300, 100, 3, path.resolve('other-QQ/QQ.exe'))], [row(300, 200, 2), row(200, 100, 3)], [row(300, 100, 3), row(100, 99, 4)], [row(300, 100, 3), row(100, 99, -1)], {}]) {
    const verify = createOwnedQqProcessVerifier({ platform: 'win32', clock: () => now, execFilePort: async () => ({ stdout: JSON.stringify(rows) }) });
    assert.equal(await verify(300, options), false);
  }
});
test('QQ process inspection errors, non-Windows and invalid PIDs cannot establish ownership', async () => {
  let calls = 0;
  const execFilePort = async () => { calls++; throw Error('unavailable'); };
  assert.equal(await createOwnedQqProcessVerifier({ platform: 'win32', execFilePort })(300, options), false);
  assert.equal(await createOwnedQqProcessVerifier({ platform: 'linux', execFilePort })(300, options), false);
  assert.equal(await createOwnedQqProcessVerifier({ platform: 'win32', execFilePort })('300;unsafe', options), false);
  assert.equal(calls, 1);
});
