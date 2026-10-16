import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildProductionPaths,
  loadMachineConfig,
  migrateMachineConfig,
  pathLooksLikeForeignProject,
  resolveCoordinatorLayout,
  resolveStateRoot,
  writeMachineConfig,
} from "../plugins/amadeus/scripts/amadeus-runtime.mjs";
import {
  evaluateSelfRepairBoundary,
  guardInstalledPluginTarget,
  planSelfRepair,
  SELF_REPAIR_MODES,
} from "../plugins/amadeus/scripts/self-repair-boundary.mjs";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeMeta = pathToFileURL(join(workerRoot, "plugins", "amadeus", "scripts", "amadeus-runtime.mjs")).href;
const packagedRuntime = join(workerRoot, "plugins", "amadeus", "runtime");

function fixture(tag = "auth") {
  const dir = mkdtempSync(join(tmpdir(), `amadeus-${tag}-`));
  return {
    dir,
    configPath: join(dir, "config.json"),
    stateRoot: join(dir, "Amadeus"),
    legacyState: join(dir, "legacy-state"),
  };
}

test("stale legacy setupRoot/coordinatorRoot config does not select executable code", () => {
  const f = fixture("stale-config");
  const legacySetup = join(f.dir, "legacy-host-setup", "coordinator");
  mkdirSync(join(legacySetup, "src"), { recursive: true });
  writeFileSync(join(legacySetup, "src", "coordinator.ts"), "export {}\n");
  writeFileSync(f.configPath, JSON.stringify({
    schemaVersion: 2,
    product: "Amadeus",
    setupRoot: join(f.dir, "legacy-host-setup"),
    coordinatorRoot: legacySetup,
    stateRoot: f.stateRoot,
  }, null, 2));

  const layout = resolveCoordinatorLayout({ configPath: f.configPath, metaUrl: runtimeMeta });
  assert.equal(layout.packaged, true);
  assert.equal(layout.authority, "packaged-runtime");
  assert.equal(layout.coordinatorRoot, packagedRuntime);
  assert.notEqual(layout.coordinatorRoot, legacySetup);

  const paths = buildProductionPaths({ configPath: f.configPath, metaUrl: runtimeMeta });
  assert.equal(paths.runtimePackaged, true);
  assert.equal(paths.coordinatorRoot, packagedRuntime);
  assert.equal(paths.stateRoot, f.stateRoot);
  assert.equal(paths.database, join(f.stateRoot, "coordinator.sqlite"));
  rmSync(f.dir, { recursive: true, force: true });
});

test("the public state default is the Amadeus folder", () => {
  const f = fixture("identity");
  const env = {
    LOCALAPPDATA: f.dir,
    AMADEUS_HOME: "",
  };
  const resolved = resolveStateRoot({
    configPath: join(f.dir, "missing-config.json"),
    env,
  });
  assert.equal(resolved, join(f.dir, "Amadeus"));
  rmSync(f.dir, { recursive: true, force: true });
});

test("compatibility reader preserves goals from legacy state without granting source authority", () => {
  const f = fixture("compat-state");
  mkdirSync(f.legacyState, { recursive: true });
  writeFileSync(join(f.legacyState, "coordinator.sqlite"), "SYNTH\n");
  writeMachineConfig({
    setupRoot: join(f.dir, "stale-setup"),
    stateRoot: f.legacyState,
  }, f.configPath);
  const paths = buildProductionPaths({ configPath: f.configPath, metaUrl: runtimeMeta });
  assert.equal(paths.runtimePackaged, true);
  assert.equal(paths.stateRoot, f.legacyState);
  assert.equal(existsSync(paths.database), true);
  assert.notEqual(paths.coordinatorRoot, join(f.dir, "stale-setup"));
  rmSync(f.dir, { recursive: true, force: true });
});

test("developer mode without verified Amadeus identity fails closed", () => {
  const f = fixture("dev-fail");
  const foreign = join(f.dir, "legacy-host-setup", "coordinator");
  mkdirSync(join(foreign, "src"), { recursive: true });
  writeFileSync(join(foreign, "src", "coordinator.ts"), "export {}\n");
  writeFileSync(join(foreign, "package.json"), JSON.stringify({
    name: "not-amadeus",
    version: "0.0.1",
  }));
  assert.equal(pathLooksLikeForeignProject(foreign, { protectedPathMarkers: ["legacy-host-setup"] }), true);
  assert.equal(pathLooksLikeForeignProject(foreign, {}), false);
  assert.throws(
    () => resolveCoordinatorLayout({
      configPath: f.configPath,
      metaUrl: runtimeMeta,
      developerMode: true,
      setupRoot: foreign,
    }),
    (error) => error.code === "FOREIGN_PROJECT_PATH" || /developer source refused/i.test(String(error)),
  );
  rmSync(f.dir, { recursive: true, force: true });
});

test("developer mode version mismatch fails closed", () => {
  const f = fixture("dev-version");
  const source = join(f.dir, "amadeus-src");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "coordinator.ts"), "export {}\n");
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "amadeus-local-ai-orchestrator",
    version: "0.0.0-mismatch",
  }));
  assert.throws(
    () => resolveCoordinatorLayout({
      metaUrl: runtimeMeta,
      developerMode: true,
      setupRoot: source,
    }),
    (error) => error.code === "VERSION_MISMATCH" || /VERSION_MISMATCH/i.test(String(error)),
  );
  rmSync(f.dir, { recursive: true, force: true });
});

test("self-repair refuses legacy host trees and keeps public installs artifact-only", () => {
  const f = fixture("repair");
  const legacy = join(f.dir, "legacy-host-setup", "coordinator");
  mkdirSync(legacy, { recursive: true });
  const refused = evaluateSelfRepairBoundary({
    targetRoot: legacy,
    metaUrl: runtimeMeta,
    config: { protectedPathMarkers: ["legacy-host-setup"] },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.mode, SELF_REPAIR_MODES.REFUSED);
  assert.equal(refused.mutateSource, false);

  const publicPlan = planSelfRepair({
    targetRoot: join(f.dir, "some-other-project"),
    stateRoot: f.stateRoot,
    metaUrl: runtimeMeta,
    artifactPayload: { summary: "synthetic repair note", files: [] },
  });
  assert.equal(publicPlan.mode, SELF_REPAIR_MODES.ARTIFACT_ONLY);
  assert.equal(publicPlan.mutateSource, false);
  assert.ok(publicPlan.artifact?.path);
  assert.equal(existsSync(publicPlan.artifact.path), true);
  const artifact = JSON.parse(readFileSync(publicPlan.artifact.path, "utf8"));
  assert.equal(artifact.mutateSource, false);
  rmSync(f.dir, { recursive: true, force: true });
});

test("machine config migration demotes setupRoot to packaged authority", () => {
  const migrated = migrateMachineConfig({
    schemaVersion: 1,
    setupRoot: "C:\\\\legacy\\\\setup",
    stateRoot: "C:\\\\legacy\\\\state",
  });
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.runtimeAuthority, "packaged");
  assert.equal(migrated.developerMode, false);
  assert.ok(migrated.legacySetupRootHint);
});

test("writeMachineConfig defaults to packaged authority and Amadeus product identity", () => {
  const f = fixture("write-config");
  const written = writeMachineConfig({ stateRoot: f.stateRoot }, f.configPath);
  assert.equal(written.schemaVersion, 3);
  assert.equal(written.runtimeAuthority, "packaged");
  assert.equal(written.developerMode, false);
  assert.equal(written.product, "Amadeus");
  assert.equal(written.publisher, "Mad Max Systems");
  assert.equal(written.stateRoot, f.stateRoot);
  const loaded = loadMachineConfig(f.configPath);
  assert.equal(loaded.runtimeAuthority, "packaged");
  rmSync(f.dir, { recursive: true, force: true });
});

test("supervisor source no longer embeds nested host coordinator/scripts authority", () => {
  const supervisor = readFileSync(join(workerRoot, "plugins", "amadeus", "runtime", "src", "supervisor.ts"), "utf8");
  assert.doesNotMatch(supervisor, /coordinator\/scripts\/New-WorkerSourceManifest/);
  assert.doesNotMatch(supervisor, /backup\/New-VerifiedCheckpoint/);
  assert.match(supervisor, /resolveSupervisorStateRoot/);
  assert.match(supervisor, /ProjectCheckpointDriver/);
  assert.match(supervisor, /assignedProjectRoot:\s*stage\.manifestValidation\.sourceRoot/);
  const adapter = readFileSync(join(workerRoot, "plugins", "amadeus", "runtime", "src", "codex-adapter.ts"), "utf8");
  assert.doesNotMatch(adapter, /Max development account/);
  assert.match(adapter, /Amadeus development workspace/);
});

test("clean-machine portability: packaged runtime resolves without private setup env", () => {
  const f = fixture("clean");
  const env = {
    LOCALAPPDATA: f.dir,
    AMADEUS_HOME: f.stateRoot,
    AMADEUS_SETUP_ROOT: "",
    AMADEUS_DEVELOPER_MODE: "",
  };
  writeMachineConfig({ stateRoot: f.stateRoot }, f.configPath);
  const paths = buildProductionPaths({
    configPath: f.configPath,
    metaUrl: runtimeMeta,
    env,
  });
  assert.equal(paths.runtimePackaged, true);
  assert.equal(paths.coordinatorRoot, packagedRuntime);
  assert.equal(paths.stateRoot, f.stateRoot);
  assert.match(paths.operations.replaceAll("\\", "/"), /runtime-config\/operations-review\.json$/);
  rmSync(f.dir, { recursive: true, force: true });
});



test("work cannot target the installed plugin folder; public repairs leave source unchanged", () => {
  const f = fixture("installed-target");
  const pluginRoot = join(f.dir, "plugins", "amadeus");
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  const source = join(pluginRoot, "scripts", "server.mjs");
  writeFileSync(source, "export const original = true;\n");
  const before = readFileSync(source, "utf8");
  const options = { pluginRoot, configPath: f.configPath, metaUrl: runtimeMeta };

  for (const target of [pluginRoot, join(pluginRoot, "scripts"), f.dir]) {
    const guarded = guardInstalledPluginTarget(target, options);
    assert.equal(guarded.ok, false, target);
    assert.equal(guarded.code, "INSTALLED_PLUGIN_TARGET");
    assert.equal(guarded.decision.mutateSource, false);
  }
  const unrelated = join(f.dir, "..", "unrelated-project");
  assert.equal(guardInstalledPluginTarget(unrelated, options).ok, true);

  const plan = planSelfRepair({ targetRoot: pluginRoot, stateRoot: f.stateRoot, configPath: f.configPath, metaUrl: runtimeMeta,
    artifactPayload: { summary: "repair note", files: ["scripts/server.mjs"] } });
  assert.equal(plan.mode, SELF_REPAIR_MODES.ARTIFACT_ONLY);
  assert.equal(readFileSync(source, "utf8"), before);
  rmSync(f.dir, { recursive: true, force: true });
});
