import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedLanguages, discoverVerificationChecks, readVerifyPolicy, verificationToolEnvironment } from '../src/verification-checks.mjs';
import { integrityOnlySummary } from '../src/deterministic-verifier.ts';
import { verificationDepth } from '../plugins/amadeus/scripts/completion-report.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'amadeus-verification-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePolicy(root, policy) {
  mkdirSync(join(root, '.amadeus'), { recursive: true });
  writeFileSync(join(root, '.amadeus', 'verify.json'), JSON.stringify(policy));
}

test('a Python-only change gets the integrity check alone, labelled as such', (t) => {
  const workspace = tempDir(t);
  writeFileSync(join(workspace, 'app.py'), 'print(1)\n');
  const checks = discoverVerificationChecks(workspace, ['app.py']);
  assert.deepEqual(checks.map((check) => check.kind), ['integrity']);
  assert.equal(checks[0].command, 'git diff --check');
});

test('opt-in pytest, go and dotnet checks are read from the authoritative project only', (t) => {
  const workspace = tempDir(t);
  const project = tempDir(t);
  writePolicy(project, { schemaVersion: 1, checks: ['pytest', { runner: 'go' }, { runner: 'dotnet', args: ['App.sln'] }] });
  // A policy inside the worker's patched copy is ignored when the project root is given.
  writePolicy(workspace, { schemaVersion: 1, checks: [] });
  const checks = discoverVerificationChecks(workspace, ['app.py'], { policyRoot: project });
  assert.deepEqual(checks.map((check) => [check.kind, check.command]), [
    ['integrity', 'git diff --check'],
    ['project-tests', 'python -m pytest -q -p no:cacheprovider'],
    ['project-tests', 'go test ./...'],
    ['project-tests', 'dotnet test --nologo App.sln'],
  ]);
  assert.deepEqual(checks[3].args, ['test', '--nologo', 'App.sln']);
  assert.equal(discoverVerificationChecks(workspace, ['app.py']).length, 1, 'the workspace policy has no checks');
});

test('verify.json rejects unsupported runners and unsafe arguments', (t) => {
  const root = tempDir(t);
  for (const [checks, message] of [
    [['cargo'], /Unsupported runner/],
    [[{ runner: 'pytest', args: ['../outside'] }], /Unsafe argument/],
    [[{ runner: 'pytest', args: ['C:\\other'] }], /Unsafe argument/],
    [[{ runner: 'go', args: ['/abs'] }], /Unsafe argument/],
    [[{ runner: 'go', args: ['a b'] }], /Unsafe argument/],
    [[{ runner: 'go', args: 'all' }], /list of at most 20/],
  ]) {
    writePolicy(root, { schemaVersion: 1, checks });
    assert.throws(() => readVerifyPolicy(root), message, JSON.stringify(checks));
  }
  writePolicy(root, { schemaVersion: 2, checks: [] });
  assert.throws(() => readVerifyPolicy(root), /schemaVersion 1/);
  writePolicy(root, { schemaVersion: 1, checks: [{ runner: 'pytest', args: ['tests/unit', '-k', 'fast'] }] });
  assert.equal(readVerifyPolicy(root)[0].command, 'python -m pytest -q -p no:cacheprovider tests/unit -k fast');
});

test('runner caches stay inside the per-check runtime home', () => {
  assert.equal(verificationToolEnvironment('go', 'C:\\rt').GOCACHE, join('C:\\rt', 'go-build'));
  assert.equal(verificationToolEnvironment('dotnet', 'C:\\rt').DOTNET_CLI_HOME, 'C:\\rt');
  assert.deepEqual(verificationToolEnvironment('npm', 'C:\\rt'), {});
});

test('an integrity-only pass says so and names the untested languages', () => {
  assert.deepEqual(changedLanguages(['src/a.py', 'cmd/main.go', 'App/Program.cs', 'README.md']), ['Python', 'Go', '.NET']);
  const summary = integrityOnlySummary(['src/a.py', 'cmd/main.go']);
  assert.match(summary, /^Integrity check only: .* no project tests ran\./);
  assert.match(summary, /Changed Python, Go code was not tested/);
  assert.match(summary, /\.amadeus\/verify\.json/);
  assert.equal(integrityOnlySummary(['README.md']), 'Integrity check only: the patch passed whitespace and integrity checks, but no project tests ran.');
});

test('the completion report counts the diff-check runner as integrity, not a product test', () => {
  const integrityRunner = { command: 'powershell pipe scripts/workspace-diff-check.mjs' };
  assert.equal(verificationDepth([integrityRunner]).status, 'partial');
  assert.equal(verificationDepth([{ command: 'git diff --check' }]).status, 'partial');
  assert.match(verificationDepth([{ kind: 'integrity', command: 'x' }]).summary, /^Integrity check only/);
  assert.equal(verificationDepth([integrityRunner, { kind: 'project-tests', command: 'go test ./...' }]).status, 'pass');
  assert.equal(verificationDepth([], ['npm test']).status, 'pass');
  assert.equal(verificationDepth([]).status, 'not_exercised');
});
