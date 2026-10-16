import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  prepareLocalCheckpointHandoff,
  probeGitCheckpointCapability,
} from '../scripts/local-checkpoint-handoff.mjs';

function tempRoot(label) {
  const root = join(process.cwd(), 'verification', 'tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, label));
}

test('probeGitCheckpointCapability reports getcwd or index write failures honestly', () => {
  const temporary = tempRoot('checkpoint-probe-');
  try {
    mkdirSync(join(temporary, '.git'), { recursive: true });
    const blocked = probeGitCheckpointCapability(temporary, () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: Unable to read current working directory: Permission denied\n',
      error: null,
    }));
    assert.equal(blocked.gitAvailable, false);
    assert.equal(blocked.getcwdBlocked, true);
    assert.equal(blocked.canCommitLocally, false);
    assert.ok(blocked.reasons.some((reason) => /getcwd/i.test(reason)));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('prepareLocalCheckpointHandoff packages exact bytes without writing .git', () => {
  const temporary = tempRoot('checkpoint-handoff-');
  try {
    mkdirSync(join(temporary, 'docs'), { recursive: true });
    mkdirSync(join(temporary, '.git'), { recursive: true });
    writeFileSync(join(temporary, 'docs', 'note.md'), 'handoff-bytes\n');
    const result = prepareLocalCheckpointHandoff({
      workspace: temporary,
      summary: 'sandbox checkpoint handoff',
      changedPaths: ['docs/note.md'],
      evidenceDir: join(temporary, 'verification', 'checkpoint-handoff'),
      runCommand: () => ({
        status: 128,
        stdout: '',
        stderr: 'fatal: Unable to read current working directory: Permission denied\n',
        error: null,
      }),
    });
    assert.equal(result.originHostAction, 'origin-host-commit-from-handoff');
    assert.equal(result.workerCanCommitLocally, false);
    assert.equal(result.push, false);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'docs/note.md');
    assert.equal(existsSync(join(result.handoffDirectory, 'files', 'docs', 'note.md')), true);
    assert.equal(readFileSync(join(result.handoffDirectory, 'files', 'docs', 'note.md'), 'utf8'), 'handoff-bytes\n');
    assert.equal(existsSync(join(temporary, '.git', 'index.lock')), false);
    assert.equal(existsSync(result.manifestPath), true);
    assert.equal(existsSync(result.latestPath), true);
    assert.match(JSON.parse(readFileSync(result.manifestPath, 'utf8')).commitMessage, /Milestone: sandbox checkpoint handoff/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
