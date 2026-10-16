import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnRepoModule } from '../scripts/spawn-repo-module.mjs';

test('canonical Codex wrapper is byte-for-byte reproducible and fails closed on drift', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'amadeus-canonical-'));
  try {
    for (const path of ['agent-package', 'plugins/amadeus', 'scripts/build-agent-package.mjs', 'package.json', 'scripts/spawn-repo-module.mjs']) { mkdirSync(join(fixture, path, '..'), { recursive: true }); cpSync(join(process.cwd(), path), join(fixture, path), { recursive: true }); }
    const nodeOptions = String(process.env.NODE_OPTIONS || '').split(/\s+/).filter((part) => part.startsWith('--import=data:') || part.startsWith('--preserve-symlinks')).join(' ');
    const run = (...args) => spawnRepoModule(join(fixture, 'scripts/build-agent-package.mjs'), {
      cwd: fixture,
      encoding: 'utf8',
      scriptArgs: args,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });
    assert.equal(run('--check').status, 0, run('--check').stderr);
    const spec = JSON.parse(readFileSync(join(fixture, 'agent-package/package.json'), 'utf8'));
    for (const path of spec.assets) {
      for (const root of ['agent-package', 'plugins/amadeus']) {
        const file = join(fixture, root, path);
        writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
      }
    }
    assert.equal(run('--check').status, 0, 'CRLF checkout must preserve canonical manifest validity');
    const asset = join(fixture, 'plugins/amadeus/skills/maestro/SKILL.md');
    const original = readFileSync(asset);
    writeFileSync(asset, 'drift');
    assert.match(run('--check').stderr, /Stale Codex wrapper/);
    assert.equal(run().status, 0);
    assert.deepEqual(readFileSync(asset), original);
    const canonical = join(fixture, 'agent-package/skills/maestro/SKILL.md');
    writeFileSync(canonical, 'canonical change');
    assert.match(run('--check').stderr, /Stale Codex wrapper/);
    const metadata = join(fixture, 'agent-package/package.json');
    spec.version = 'wrong'; writeFileSync(metadata, JSON.stringify(spec));
    assert.match(run().stderr, /identity or version mismatch/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
