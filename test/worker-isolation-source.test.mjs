import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifestSources } from '../src/worker-isolation.ts';

test('manifest source validation rejects linked parent directories', (t) => {
  const root = mkdtempSync(join(process.cwd(), '.isolation-source-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actual = join(root, 'actual');
  mkdirSync(actual);
  const bytes = Buffer.from('source');
  writeFileSync(join(actual, 'file.txt'), bytes);
  const link = join(root, 'linked');
  try {
    symlinkSync(actual, link, 'junction');
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('junction creation denied by host');
    throw error;
  }
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1,
    source: { projectRoot: root, baseRevision: 'fixture' },
    files: [{ path: 'linked/file.txt', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  assert.throws(() => validateManifestSources(manifest), /link or non-regular component/);
});

test('manifest source validation accepts regular nested directories', (t) => {
  const root = mkdtempSync(join(process.cwd(), '.isolation-regular-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'nested'));
  const bytes = Buffer.from('source');
  writeFileSync(join(root, 'nested', 'file.txt'), bytes);
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1,
    source: { projectRoot: root, baseRevision: 'fixture' },
    files: [{ path: 'nested/file.txt', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  try {
    assert.equal(validateManifestSources(manifest).files, 1);
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('realpath denied by host; containment requires host verification');
    throw error;
  }
});
