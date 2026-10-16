import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
test('staged Claude Code fixture maps canonical entrypoints without activation', () => {
  const canonical = json('agent-package/package.json');
  const fixture = json('host-fixtures/claude-code/parity.json');
  const manifest = json('host-fixtures/claude-code/.claude-plugin/plugin.json');
  const mcp = json('host-fixtures/claude-code/.mcp.json');
  const hooks = json('host-fixtures/claude-code/hooks/hooks.json');
  assert.equal(fixture.status, 'candidate-marketplace-host-published-worker-optional');
  assert.equal(fixture.version, canonical.version);
  assert.equal(manifest.version, canonical.version);
  assert.equal(manifest.name, canonical.name);
  for (const asset of fixture.canonicalAssets) {
    assert.ok(canonical.assets.includes(asset), asset);
    assert.ok(existsSync(`agent-package/${asset}`), asset);
  }
  assert.ok(Array.isArray(fixture.deterministicAdapterChecks));
  assert.ok(fixture.deterministicAdapterChecks.includes('install-update-rollback-disable-uninstall'));
  assert.ok(fixture.pilotRequired.includes('live-signed-in-host-and-e2e-canaries'));
  assert.equal(mcp.mcpServers.amadeus.command, 'node');
  assert.equal(mcp.mcpServers.amadeus.args[0], '${CLAUDE_PLUGIN_ROOT}/scripts/server.mjs');
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"');
  assert.ok(!existsSync('host-fixtures/claude-code/scripts/server.mjs'));
  assert.ok(!existsSync('host-fixtures/claude-code/skills/amadeus/SKILL.md'));
});
