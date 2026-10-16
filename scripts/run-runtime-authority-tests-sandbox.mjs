/**
 * Sandbox-friendly runtime authority / self-repair boundary checks.
 * Loads modules via data: URL to avoid EPERM on lstat('C:\\').
 */
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
import { pathToFileURL } from "node:url";

const root = process.cwd();
const scriptsDir = join(root, "plugins", "amadeus", "scripts");
const packagedRuntime = join(root, "plugins", "amadeus", "runtime");
const runtimeMeta = pathToFileURL(join(scriptsDir, "amadeus-runtime.mjs")).href;

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function rewriteRelativeImports(source, baseDir) {
  return source.replace(/from\s+["']\.\/([^"']+)["']/g, (_match, spec) => {
    const depAbs = join(baseDir, spec);
    const depSource = rewriteRelativeImports(readFileSync(depAbs, "utf8"), baseDir);
    return `from ${JSON.stringify(toDataUrl(depSource))}`;
  });
}

const runtime = await import(toDataUrl(rewriteRelativeImports(
  readFileSync(join(scriptsDir, "amadeus-runtime.mjs"), "utf8"),
  scriptsDir,
)));
const repair = await import(toDataUrl(rewriteRelativeImports(
  readFileSync(join(scriptsDir, "self-repair-boundary.mjs"), "utf8"),
  scriptsDir,
)));

function fixture(tag = "auth") {
  const dir = mkdtempSync(join(tmpdir(), `amadeus-${tag}-`));
  return {
    dir,
    configPath: join(dir, "config.json"),
    stateRoot: join(dir, "Amadeus"),
    legacyState: join(dir, "legacy-state"),
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
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
  const layout = runtime.resolveCoordinatorLayout({ configPath: f.configPath, metaUrl: runtimeMeta });
  assert.equal(layout.packaged, true);
  assert.equal(layout.authority, "packaged-runtime");
  assert.equal(layout.coordinatorRoot, packagedRuntime);
  const paths = runtime.buildProductionPaths({ configPath: f.configPath, metaUrl: runtimeMeta });
  assert.equal(paths.runtimePackaged, true);
  assert.equal(paths.stateRoot, f.stateRoot);
  rmSync(f.dir, { recursive: true, force: true });
});

test("compatibility reader preserves goals from legacy state without granting source authority", () => {
  const f = fixture("compat-state");
  mkdirSync(f.legacyState, { recursive: true });
  writeFileSync(join(f.legacyState, "coordinator.sqlite"), "SYNTH\n");
  runtime.writeMachineConfig({
    setupRoot: join(f.dir, "stale-setup"),
    stateRoot: f.legacyState,
  }, f.configPath);
  const paths = runtime.buildProductionPaths({ configPath: f.configPath, metaUrl: runtimeMeta });
  assert.equal(paths.runtimePackaged, true);
  assert.equal(paths.stateRoot, f.legacyState);
  assert.equal(existsSync(paths.database), true);
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
  assert.equal(runtime.pathLooksLikeForeignProject(foreign, { protectedPathMarkers: ["legacy-host-setup"] }), true);
  assert.equal(runtime.pathLooksLikeForeignProject(foreign, {}), false);
  assert.throws(
    () => runtime.resolveCoordinatorLayout({
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
    () => runtime.resolveCoordinatorLayout({
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
  const refused = repair.evaluateSelfRepairBoundary({
    targetRoot: legacy,
    metaUrl: runtimeMeta,
    config: { protectedPathMarkers: ["legacy-host-setup"] },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.mode, repair.SELF_REPAIR_MODES.REFUSED);
  assert.equal(refused.mutateSource, false);

  const publicPlan = repair.planSelfRepair({
    targetRoot: join(f.dir, "some-other-project"),
    stateRoot: f.stateRoot,
    metaUrl: runtimeMeta,
    artifactPayload: { summary: "synthetic repair note", files: [] },
  });
  assert.equal(publicPlan.mode, repair.SELF_REPAIR_MODES.ARTIFACT_ONLY);
  assert.equal(publicPlan.mutateSource, false);
  assert.ok(publicPlan.artifact?.path);
  assert.equal(existsSync(publicPlan.artifact.path), true);
  rmSync(f.dir, { recursive: true, force: true });
});

test("machine config migration demotes setupRoot to packaged authority", () => {
  const migrated = runtime.migrateMachineConfig({
    schemaVersion: 1,
    setupRoot: "C:\\\\legacy\\\\setup",
    stateRoot: "C:\\\\legacy\\\\state",
  });
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.runtimeAuthority, "packaged");
  assert.equal(migrated.developerMode, false);
});

test("supervisor source no longer embeds nested host coordinator/scripts authority", () => {
  const supervisor = readFileSync(join(root, "plugins", "amadeus", "runtime", "src", "supervisor.ts"), "utf8");
  assert.doesNotMatch(supervisor, /coordinator\/scripts\/New-WorkerSourceManifest/);
  assert.doesNotMatch(supervisor, /backup\/New-VerifiedCheckpoint/);
  assert.match(supervisor, /resolveSupervisorStateRoot/);
  const adapter = readFileSync(join(root, "plugins", "amadeus", "runtime", "src", "codex-adapter.ts"), "utf8");
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
  runtime.writeMachineConfig({ stateRoot: f.stateRoot }, f.configPath);
  const paths = runtime.buildProductionPaths({
    configPath: f.configPath,
    metaUrl: runtimeMeta,
    env,
  });
  assert.equal(paths.runtimePackaged, true);
  assert.equal(paths.coordinatorRoot, packagedRuntime);
  assert.equal(paths.stateRoot, f.stateRoot);
  rmSync(f.dir, { recursive: true, force: true });
});

console.log("runtime-authority sandbox checks passed");


