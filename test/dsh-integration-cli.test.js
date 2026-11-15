import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'xx-integration-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function run(root, script, args, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^DSH_(TEST_|HOME$)/i.test(name)));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url)), ...args], {
    env: { ...env, DSH_HOME: join(root, 'configured-home'), DSH_TEST_INSTALL: join(root, 'missing-dsh'),
      DSH_TEST_ARTIFACTS: join(root, 'artifacts'), ...overrides },
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

test('main integration help and invalid invocations cannot create artifacts or a DSH home', async t => {
  const root = await sandbox(t);
  const script = 'dsh-integration';
  const home = join(root, 'new-home');
  for (const flag of ['--help', '-h']) {
    const help = run(root, script, [flag], { DSH_TEST_HOME: home });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--fixture-only.*--base-only.*--real-only/);
  }
  for (const [args, error] of [
    [[], /Choose exactly one/],
    [['--fixture-only', '--real-only', '--home', home], /Choose exactly one/],
    [['--fixture-only', '--artifacts'], /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/],
    [['--fixture-only', '--fixtur-only', '--home', home], /ERR_PARSE_ARGS_UNKNOWN_OPTION/],
    [['--fixture-only', '--fixture-only', '--home', home], /only once/],
    [['--fixture-only'], /DSH_TEST_HOME_REQUIRED/],
    [['--fixture-only', '--home', 'relative-home'], /DSH_TEST_HOME_REQUIRED/],
  ]) {
    const failed = run(root, script, args);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, error);
  }
  const invalidTimeout = run(root, script, ['--fixture-only', '--home', home], { DSH_TEST_TIMEOUT_MS: '0' });
  assert.equal(invalidTimeout.status, 1);
  assert.match(invalidTimeout.stderr, /positive integers/);
  const incompleteProvider = run(root, script, ['--real-only', '--home', home], { DSH_TEST_PROVIDER: 'fixture-test' });
  assert.equal(incompleteProvider.status, 1);
  assert.match(incompleteProvider.stderr, /together/);
  assert.deepEqual(await readdir(root), []);
});

test('main integration refuses existing and production paths, including junction aliases', async t => {
  const root = await sandbox(t);
  const production = join(root, 'configured-home'), alias = join(root, 'linked-home'), home = join(root, 'new-home');
  await mkdir(production);
  await writeFile(join(production, 'sentinel'), 'preserve');
  await symlink(production, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const script = 'dsh-integration';
  for (const [args, error] of [
    [['--home', join(production, 'test')], /DSH_TEST_HOME_CONFLICT/],
    [['--home', production], /DSH_TEST_HOME_EXISTS/],
    [['--home', join(alias, 'test')], /DSH_TEST_HOME_CONFLICT/],
    [['--home', home, '--artifacts', join(alias, 'evidence')], /DSH_TEST_HOME_CONFLICT/],
    [['--home', join(homedir(), '.dsh')], /DSH_TEST_HOME_CONFLICT/],
  ]) {
    const failed = run(root, script, ['--fixture-only', ...args]);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, error);
  }
  assert.deepEqual((await readdir(root)).sort(), ['configured-home', 'linked-home']);
  assert.deepEqual(await readdir(production), ['sentinel']);
  assert.equal(await readFile(join(production, 'sentinel'), 'utf8'), 'preserve');
});

test('fresh explicit DSH_TEST_HOME with matching DSH_HOME reaches read-only host validation', async t => {
  const root = await sandbox(t);
  const home = join(root, 'new-home');
  for (const mode of ['--fixture-only', '--base-only', '--real-only']) {
    const failed = run(root, 'dsh-integration', [mode], { DSH_HOME: home, DSH_TEST_HOME: home });
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, /HOST_NOT_FOUND/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('standalone lifecycle help and invalid options cannot reach the paid runner', async t => {
  const root = await sandbox(t);
  const script = 'dsh-real-lifecycle', artifacts = join(root, 'lifecycle-artifacts');
  const help = run(root, script, ['--help', '--artifacts', artifacts]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--real/);
  for (const [args, error] of [
    [['--artifacts', artifacts], /explicitly select/],
    [['--real', '--reel', '--artifacts', artifacts], /ERR_PARSE_ARGS_UNKNOWN_OPTION/],
    [['--real', '--real', '--artifacts', artifacts], /only once/],
    [['--real', '--artifacts'], /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/],
    [['--real', '--start-phase', 'NaN', '--artifacts', artifacts], /integer from 1 to 9/],
    [['--real', '--start-phase', '10', '--artifacts', artifacts], /integer from 1 to 9/],
    [['--real', '--artifacts', artifacts], /DSH_TEST_HOME_REQUIRED/],
    [['--real', '--home', join(root, 'new-home'), '--artifacts', artifacts], /executable missing/],
  ]) {
    const failed = run(root, script, args);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, error);
  }
  assert.deepEqual(await readdir(root), []);
});

test('standalone lifecycle rejects existing homes and requires a matching resume marker', async t => {
  const root = await sandbox(t);
  const home = join(root, 'unowned-home'), artifacts = join(root, 'lifecycle-artifacts'), checkpoint = join(artifacts, 'checkpoint');
  const install = join(root, 'fake-install');
  await mkdir(home);
  await mkdir(checkpoint, { recursive: true });
  await mkdir(install);
  // This sentinel gets past existence validation. It must never be launched.
  await writeFile(join(install, 'DSH NEXT.exe'), 'not executable');
  await writeFile(join(checkpoint, 'result.json'), JSON.stringify({ dshHome: home }));
  const args = ['--real', '--home', home, '--artifacts', artifacts];
  for (const [flags, error] of [
    [[], /DSH_TEST_HOME_EXISTS/],
    [['--resume-dir', checkpoint], /original isolated lifecycle home/],
  ]) {
    const failed = run(root, 'dsh-real-lifecycle', [...args, ...flags], { DSH_TEST_INSTALL: install });
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, error);
  }
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readdir(artifacts), ['checkpoint']);
});
