import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeUrl = pathToFileURL(join(workerRoot, "plugins", "amadeus", "scripts", "amadeus-runtime.mjs")).href;
const dependencyHealthUrl = pathToFileURL(join(workerRoot, "plugins", "amadeus", "scripts", "dependency-health.mjs")).href;
const {
  detectAccelerators,
  missingDependencyReport,
  buildProductionPaths,
  writeMachineConfig,
} = await import(runtimeUrl);
const { dependencyHealth } = await import(dependencyHealthUrl);

test("missing Cursor config is optional and does not fail baseline dependency report", () => {
  const temp = mkdtempSync(join(tmpdir(), "amadeus-deps-"));
  const coordinatorRoot = join(temp, "coord");
  mkdirSync(join(coordinatorRoot, "src"), { recursive: true });
  writeFileSync(join(coordinatorRoot, "src", "coordinator.ts"), "export {}\n");
  writeFileSync(join(coordinatorRoot, "src", "supervisor.ts"), "export {}\n");
  writeFileSync(join(coordinatorRoot, "operations-review.json"), "{}\n");
  writeFileSync(join(coordinatorRoot, "worker-config.json"), "{}\n");
  const paths = {
    setupRoot: temp,
    stateRoot: join(temp, "state"),
    coordinatorRoot,
    operations: join(coordinatorRoot, "operations-review.json"),
    workerConfig: join(coordinatorRoot, "worker-config.json"),
    cursorWorkerConfig: join(coordinatorRoot, "cursor-worker-config.json"),
    supervisor: join(coordinatorRoot, "src", "supervisor.ts"),
  };
  assert.equal(existsSync(paths.cursorWorkerConfig), false);
  const report = missingDependencyReport(paths);
  assert.equal(report.ok, true);
  assert.equal(report.cursorOptional, true);
  assert.equal(report.missing.length, 0);
  assert.ok(report.missingOptional.some((item) => item.label.includes("cursor")));
});

test("detectAccelerators treats Cursor as optional and never blocks baseline work", () => {
  const report = detectAccelerators({
    which: () => null,
    cursorInstalled: false,
    catalogModels: [{ slug: "gpt-test", priority: 1 }],
    codexSignedIn: true,
  });
  assert.equal(report.cursor.available, false);
  assert.equal(report.cursor.optional, true);
  assert.equal(report.codex.available, true);
  assert.equal(report.blocksStartupWhenCursorMissing, false);
  assert.equal(report.blocksPreflightWhenCursorMissing, false);
  assert.equal(report.blocksWorkWhenCursorMissing, false);
  assert.match(report.baseline, /ordinary-software/);
});

test("dependency health reports the active Cursor config instead of dropping its path", () => {
  const temp = mkdtempSync(join(tmpdir(), "amadeus-cursor-health-"));
  const cursorWorkerConfigPath = join(temp, "cursor-worker-config.json");
  writeFileSync(cursorWorkerConfigPath, "{}\n");
  const report = dependencyHealth({
    stateRoot: temp,
    cursorWorkerConfigPath,
    cursorInstalled: true,
    which: () => null,
    catalog: { models: [] },
    registry: {},
  });
  assert.equal(report.cursor.configured, true);
  const server = readFileSync(join(workerRoot, "plugins", "amadeus", "scripts", "server.mjs"), "utf8");
  assert.match(server, /cursorWorkerConfigPath:\s*paths\?\.cursorWorkerConfig/);
});

test("Cursor acceptance validates a pristine worker before creating probe files", () => {
  const source = readFileSync(join(workerRoot, "src", "cursor-project-scope-acceptance.mjs"), "utf8");
  const packaged = readFileSync(join(workerRoot, "plugins", "amadeus", "runtime", "src",
    "cursor-project-scope-acceptance.mjs"), "utf8");
  assert.equal(packaged.replaceAll('\r\n', '\n'), source.replaceAll('\r\n', '\n'));
  const plan = source.indexOf("const plan = buildCursorImplementationPlan");
  const launch = source.indexOf("const launch = buildCursorContainmentLaunch");
  const firstWorkspaceProbe = source.indexOf("if (approvedPath && !approvedExisted) writeFileSync");
  assert.ok(plan >= 0 && launch > plan && firstWorkspaceProbe > launch,
    "clean-workspace validation must run before disposable probe files are created");
});

test("portable layout resolves coordinator without a private setup tree env", () => {
  const temp = mkdtempSync(join(tmpdir(), "amadeus-portable-"));
  const configPath = join(temp, "config.json");
  mkdirSync(join(temp, "src"), { recursive: true });
  writeFileSync(join(temp, "src", "coordinator.ts"), "export {}\n");
  writeFileSync(join(temp, "operations-review.json"), "{}\n");
  writeFileSync(join(temp, "worker-config.json"), "{}\n");
  writeFileSync(join(temp, "src", "supervisor.ts"), "export {}\n");
  writeMachineConfig({ setupRoot: temp, stateRoot: join(temp, "state") }, configPath);
  const paths = buildProductionPaths({
    configPath,
    metaUrl: pathToFileURL(join(temp, "plugin", "scripts", "x.mjs")).href,
    setupRoot: temp,
    allowExplicitLayout: true,
  });
  assert.equal(paths.coordinatorRoot, temp);
  assert.equal(paths.setupRoot, temp);
  const report = missingDependencyReport(paths);
  assert.equal(report.ok, true);
});

test("in-repo marketplace keeps relative in-root Amadeus path", () => {
  const market = JSON.parse(readFileSync(join(workerRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
  const path = market.plugins[0].source.path;
  assert.match(path, /^\.\//);
  assert.equal(market.plugins[0].name, "amadeus");
  assert.equal(market.plugins[0].policy.installation, "INSTALLED_BY_DEFAULT");
  assert.ok(existsSync(join(workerRoot, path, ".codex-plugin", "plugin.json")));
});

test("config templates are privacy-clean and Cursor-optional", () => {
  for (const name of ["worker-config.json", "cursor-worker-config.json", "operations-review.json"]) {
    const text = readFileSync(join(workerRoot, "config-templates", name), "utf8");
    // Templates must not carry any user's home folder or drive-specific path.
    assert.doesNotMatch(text, /[A-Za-z]:(?:\\\\|\/)Users(?:\\\\|\/)/i);
    assert.doesNotMatch(text, /\/(?:Users|home)\/[^"/]+\//);
  }
  const cursor = JSON.parse(readFileSync(join(workerRoot, "config-templates", "cursor-worker-config.json"), "utf8"));
  assert.equal(cursor.enabled, false);
  assert.match(String(cursor.notes), /optional|Missing Cursor/i);
});

test("personal activation cache version tracks the released plugin version", () => {
  const plugin = JSON.parse(readFileSync(join(workerRoot, "plugins", "amadeus", ".codex-plugin", "plugin.json"), "utf8"));
  const activation = readFileSync(join(workerRoot, "scripts", "Activate-AmadeusPersonalPlugin.ps1"), "utf8");
  assert.ok(activation.includes(`[string]$Version = "${plugin.version}"`));
});
