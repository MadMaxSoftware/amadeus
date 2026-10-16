import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));

test("clean packaged install and upgrade keep private state and require no discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "amadeus-clean-machine-"));
  try {
    const target = join(dir, "checkout");
    mkdirSync(join(target, "scripts"), { recursive: true });
    cpSync(join(root, "plugins", "amadeus"), join(target, "plugins", "amadeus"), { recursive: true });
    cpSync(join(root, "scripts", "install-dependencies.mjs"), join(target, "scripts", "install-dependencies.mjs"));
    writeFileSync(join(target, "package.json"), '{"type":"module"}');
    const state = join(dir, "private-state");
    const config = join(state, "config.json");
    const env = { ...process.env, AMADEUS_CONFIG: config, AMADEUS_HOME: state,
      AMADEUS_SETUP_ROOT: "", PATH: "" };
    const run = () => spawnSync(process.execPath, [join(target, "scripts", "install-dependencies.mjs")],
      { cwd: target, env, encoding: "utf8", timeout: 15000 });
    const first = run();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(JSON.parse(first.stdout).runtimeAuthority, "packaged");
    assert.equal(JSON.parse(readFileSync(config, "utf8")).developerMode, false);
    assert.equal(existsSync(join(state, "runtime-config", "worker-config.json")), true);
    assert.equal(existsSync(join(target, "worker-config.json")), false);
    const goals = join(state, "goals.json");
    writeFileSync(goals, '{"preserve":true}');
    const worker = join(state, "runtime-config", "worker-config.json");
    const ownerConfig = { ...JSON.parse(readFileSync(config, "utf8")), ownerSetting: true };
    writeFileSync(config, JSON.stringify(ownerConfig));
    const workerConfig = { ...JSON.parse(readFileSync(worker, "utf8")), ownerSetting: true };
    writeFileSync(worker, JSON.stringify(workerConfig));
    // Cursor is optional, so baseline status stays ready after its config is lost.
    // Re-running installation must still repair the missing adapter configuration.
    const cursor = join(state, "runtime-config", "cursor-worker-config.json");
    rmSync(cursor);
    const second = run();
    assert.equal(existsSync(cursor), true);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(goals, "utf8"), '{"preserve":true}');
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), ownerConfig);
    assert.deepEqual(JSON.parse(readFileSync(worker, "utf8")), workerConfig);
    assert.equal(existsSync(join(state, "providers", "last-scan.json")), false);
    assert.equal(existsSync(join(state, "updates", "consent.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
