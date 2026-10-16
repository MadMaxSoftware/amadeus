import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
// Data URL loading avoids the Windows worker sandbox's denied parent-path lstat.
const excludedSource = readFileSync('src/excluded-development-path.mjs', 'utf8');
const excludedUrl = `data:text/javascript;base64,${Buffer.from(excludedSource).toString('base64')}`;
const hostSource = readFileSync('src/host-drivers.ts', 'utf8')
  .replace('from "./development-project.ts"', `from "${excludedUrl}"`);
assert.match(hostSource, /input: patchBytes/);
assert.doesNotMatch(hostSource, /"--check", patchPath/);
const { GuardedGitPatchApplicator } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(hostSource)).toString('base64')}`);

test('verified patch bytes apply, while a changed artifact is rejected', async (t) => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-amadeus-patch-'));
  try {
    const projectRoot = join(root, 'project');
    const artifactRoot = join(root, 'artifacts');
    mkdirSync(projectRoot); mkdirSync(artifactRoot);
    const git = (args) => execFileSync('git', ['-C', projectRoot, ...args]);
    try { git(['init', '-q']); }
    catch (error) {
      if (/Permission denied/.test(String(error.stderr))) { t.skip('sandbox denies Git access to worker parent path'); return; }
      throw error;
    }
    git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(projectRoot, 'allowed.txt'), 'before\n');
    git(['add', 'allowed.txt']); git(['commit', '-qm', 'baseline']);
    writeFileSync(join(projectRoot, 'allowed.txt'), 'after\n');
    const bytes = git(['diff', '--binary']);
    git(['checkout', '--', 'allowed.txt']);
    const patchPath = join(artifactRoot, 'change.patch');
    writeFileSync(patchPath, bytes);
    const configPath = join(root, 'worker.json');
    const receiptPath = join(root, 'checkpoint.json');
    writeFileSync(configPath, JSON.stringify({ writableWorkspacePaths: ['allowed.txt'] }));
    writeFileSync(receiptPath, '{}');
    const patch = { path: patchPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), changedFiles: 1 };
    const applicator = new GuardedGitPatchApplicator({ projectRoot, artifactRoot, workerConfig: configPath });
    await applicator.apply(patch, receiptPath);
    assert.equal(readFileSync(join(projectRoot, 'allowed.txt'), 'utf8'), 'after\n');
    git(['checkout', '--', 'allowed.txt']);
    writeFileSync(patchPath, Buffer.from(bytes.toString().replace('after', 'other')));
    await assert.rejects(applicator.apply(patch, receiptPath), /hash or size/);
    assert.equal(readFileSync(join(projectRoot, 'allowed.txt'), 'utf8'), 'before\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
