import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  applyMigration,
  compareInventories,
  defaultCanonicalStateRoot,
  discoverKnownStateRoots,
  inventoryStateRoot,
  planMigration,
  publicSafeDiscoveryReport,
  readJournal,
  readSchemaJournal,
  rollbackMigration,
  runStateMigrationWorkflow,
  verifyMigration,
  DURABLE_ENTRIES,
} from "../plugins/amadeus/scripts/state-migration.mjs";
import { assertNoPersonalLeak, writeMachineConfig } from "../plugins/amadeus/scripts/amadeus-runtime.mjs";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));


function synthDatabase(path, value) { const db=new DatabaseSync(path); try { db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)'); db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('synthetic',value); } finally { db.close(); } }
function synthDatabaseValue(path) { const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT value FROM settings WHERE key=?').get('synthetic').value;}finally{db.close();} }

function synthFixture(tag = "mig") {
  const fixtureRoot = join(workerRoot, ".tmp", "state-migration-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const dir = mkdtempSync(join(fixtureRoot, `amadeus-${tag}-`));
  const source = join(dir, "legacy-state");
  const target = join(dir, "Amadeus");
  const configPath = join(dir, "config.json");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(source, "providers"), { recursive: true });
  mkdirSync(join(source, "updates"), { recursive: true });
  mkdirSync(join(source, "goal-packages", "g1"), { recursive: true });
  synthDatabase(join(source, "coordinator.sqlite"), "SYNTH-DB-v1\n");
  writeFileSync(join(source, "preferences.json"), JSON.stringify({ theme: "synth" }));
  writeFileSync(join(source, "providers", "registry.json"), JSON.stringify({
    schemaVersion: 1,
    providers: { "loopback-synth": { approved: true, qualification: "passed" } },
  }));
  writeFileSync(join(source, "providers", "discovery-consent.json"), JSON.stringify({
    discovery: false,
    scopes: [],
  }));
  writeFileSync(join(source, "updates", "consent.json"), JSON.stringify({ updateChecks: false }));
  writeFileSync(join(source, "goal-packages", "g1", "meta.json"), JSON.stringify({ id: "g1", synthetic: true }));
  return { dir, source, target, configPath };
}

test("synthetic inventory fingerprints durable allowlisted entries only", () => {
  const f = synthFixture("inv");
  writeFileSync(join(f.source, "noise.tmp"), "ignore");
  const inv = inventoryStateRoot(f.source);
  assert.equal(inv.hasCoordinatorDb, true);
  assert.ok(inv.entries.some((e) => e.name === "coordinator.sqlite"));
  assert.ok(inv.entries.some((e) => e.name === "providers"));
  assert.equal(inv.entries.some((e) => e.name === "noise.tmp"), false);
  assert.ok(DURABLE_ENTRIES.includes("coordinator.sqlite"));
  rmSync(f.dir, { recursive: true, force: true });
});

test("inventory supports long-lived state trees with more than 5,000 files", () => {
  const f = synthFixture("large-inventory");
  const history = join(f.source, "goal-runs", "history");
  mkdirSync(history, { recursive: true });
  for (let index = 0; index < 5001; index += 1) {
    writeFileSync(join(history, `${index}.json`), "{}\n");
  }
  const inv = inventoryStateRoot(f.source);
  const goalRuns = inv.entries.find((entry) => entry.name === "goal-runs");
  assert.equal(goalRuns.fingerprint.files, 5001);
  rmSync(f.dir, { recursive: true, force: true });
});

test("dry-run plan does not write; apply migrates; verify passes; second apply is idempotent", () => {
  const f = synthFixture("flow");
  writeMachineConfig({ setupRoot: f.dir, stateRoot: f.source }, f.configPath);
  const env = {
    ...process.env,
    AMADEUS_HOME: f.source,
    LOCALAPPDATA: f.dir,
  };

  const dry = runStateMigrationWorkflow({
    sourceRoot: f.source,
    targetRoot: f.target,
    configPath: f.configPath,
    setupRoot: f.dir,
    env,
    dryRun: true,
  });
  assert.equal(dry.plan.ok, true);
  assert.equal(dry.result.dryRun, true);
  assert.equal(dry.result.applied, false);
  assert.equal(existsSync(join(f.target, "coordinator.sqlite")), false);

  const first = runStateMigrationWorkflow({
    sourceRoot: f.source,
    targetRoot: f.target,
    configPath: f.configPath,
    setupRoot: f.dir,
    env,
    dryRun: false,
    updateMachineConfig: true,
    force: true,
  });
  assert.equal(first.result.applied, true);
  assert.equal(first.verification.ok, true);
  assert.equal(synthDatabaseValue(join(f.target, "coordinator.sqlite")), "SYNTH-DB-v1\n");
  assert.ok(readJournal(f.target)?.backupId);
  assert.equal(readSchemaJournal(f.target)?.stateSchemaVersion, 1);

  const second = runStateMigrationWorkflow({
    sourceRoot: f.source,
    targetRoot: f.target,
    configPath: f.configPath,
    setupRoot: f.dir,
    env: { ...env, AMADEUS_HOME: f.target },
    dryRun: false,
  });
  assert.equal(second.result.idempotent, true);
  assert.equal(second.result.applied, false);
  assert.equal(second.verification.ok, true);
  rmSync(f.dir, { recursive: true, force: true });
});

test("conflict policy fail blocks; prefer-source backups and replaces; rollback restores", () => {
  const f = synthFixture("conflict");
  mkdirSync(f.target, { recursive: true });
  synthDatabase(join(f.target, "coordinator.sqlite"), "SYNTH-DB-v1\n");
  writeFileSync(join(f.target, "preferences.json"), JSON.stringify({ theme: "target" }));

  const blocked = planMigration({
    sourceRoot: f.source,
    targetRoot: f.target,
    conflictPolicy: "fail",
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocking.includes("preferences.json"));

  const plan = planMigration({
    sourceRoot: f.source,
    targetRoot: f.target,
    conflictPolicy: "prefer-source",
  });
  assert.equal(plan.ok, true);
  const applied = applyMigration(plan, { dryRun: false });
  assert.equal(applied.applied, true);
  assert.equal(synthDatabaseValue(join(f.target, "coordinator.sqlite")), "SYNTH-DB-v1\n");
  const backupId = applied.backupId;
  assert.ok(backupId);
  assert.ok(existsSync(join(f.target, "migration", "backups", backupId, "preferences.json")));

  const rbDry = rollbackMigration({ targetRoot: f.target, backupId, dryRun: true });
  assert.equal(rbDry.dryRun, true);
  const rb = rollbackMigration({ targetRoot: f.target, backupId, dryRun: false });
  assert.equal(rb.ok, true);
  assert.equal(synthDatabaseValue(join(f.target, "coordinator.sqlite")), "SYNTH-DB-v1\n");
  assert.equal(readJournal(f.target)?.status, "rolled-back");
  rmSync(f.dir, { recursive: true, force: true });
});

test("same-root and empty-source plans are conflict-safe no-ops", () => {
  const f = synthFixture("noop");
  const same = planMigration({ sourceRoot: f.source, targetRoot: f.source });
  assert.equal(same.mode, "noop-same-root");
  const emptyDir = join(f.dir, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const empty = planMigration({ sourceRoot: emptyDir, targetRoot: f.target });
  assert.equal(empty.mode, "noop-empty-source");
  const applied = applyMigration(same, { dryRun: false });
  assert.equal(applied.applied, true);
  assert.equal(readJournal(f.source)?.mode, "noop-same-root");
  rmSync(f.dir, { recursive: true, force: true });
});

test("marketplace identity / version cache change still resolves shared synthetic state root", () => {
  const f = synthFixture("cache");
  const personalCache = join(f.dir, "plugin-cache", "amadeus-personal", "0.3.1");
  const publicCache = join(f.dir, "plugin-cache", "amadeus", "0.3.2");
  mkdirSync(personalCache, { recursive: true });
  mkdirSync(publicCache, { recursive: true });
  writeFileSync(join(personalCache, "plugin.json"), JSON.stringify({ name: "amadeus", version: "0.3.1" }));
  writeFileSync(join(publicCache, "plugin.json"), JSON.stringify({ name: "amadeus", version: "0.3.2" }));
  writeMachineConfig({ setupRoot: f.dir, stateRoot: f.source }, f.configPath);

  const env = {
    ...process.env,
    LOCALAPPDATA: join(f.dir, "Local"),
    AMADEUS_HOME: undefined,
  };
  delete env.AMADEUS_HOME;
  // Both identities use the same machine config stateRoot — not the versioned caches.
  const discovery = discoverKnownStateRoots({
    env: { ...env, LOCALAPPDATA: join(f.dir, "Local") },
    configPath: f.configPath,
    setupRoot: f.dir,
  });
  assert.equal(discovery.resolvedStateRoot, f.source);
  assert.equal(discovery.shareStableDataRoot, true);
  assert.ok(discovery.roots.every((root) => root.inventory.entries.every((entry) => entry.fingerprint === null)));
  assert.equal(existsSync(join(personalCache, "coordinator.sqlite")), false);
  assert.equal(existsSync(join(publicCache, "coordinator.sqlite")), false);
  const report = publicSafeDiscoveryReport(discovery);
  assertNoPersonalLeak(JSON.stringify(report), "synth-discovery");
  rmSync(f.dir, { recursive: true, force: true });
});

test("multiple coordinator histories fail closed instead of selecting a winner", () => {
  const f = synthFixture("multi-root");
  const setupRoot = join(f.dir, "setup");
  const setupState = join(setupRoot, "coordinator-state");
  mkdirSync(setupState, { recursive: true });
  synthDatabase(join(setupState, "coordinator.sqlite"), "SECOND-SYNTH-DB\n");
  writeMachineConfig({ setupRoot, stateRoot: f.source }, f.configPath);
  const discovery = discoverKnownStateRoots({
    env: { ...process.env, LOCALAPPDATA: join(f.dir, "Local") },
    configPath: f.configPath,
    setupRoot,
  });
  assert.equal(discovery.requiresConsolidation, true);
  assert.equal(publicSafeDiscoveryReport(discovery).requiresConsolidation, true);
  assert.throws(
    () => runStateMigrationWorkflow({ discovery, targetRoot: f.target }),
    /Multiple coordinator histories/,
  );
  assert.equal(existsSync(f.target), false);
  rmSync(f.dir, { recursive: true, force: true });
});

test("package and git ignore exclude personal state artifacts; migration module is public-safe", () => {
  const gitignore = readFileSync(join(workerRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /\*\.sqlite/);
  assert.match(gitignore, /verification\//);
  assert.match(gitignore, /_quarantine_host_only\//);

  const migrationSrc = readFileSync(join(workerRoot, "plugins", "amadeus", "scripts", "state-migration.mjs"), "utf8");
  assertNoPersonalLeak(migrationSrc, "state-migration.mjs");
  // Ensure we never ship a filled machine config inside the plugin package.
  assert.equal(existsSync(join(workerRoot, "plugins", "amadeus", "config.json")), false);

  const packCheck = spawnSync(process.execPath, [join(workerRoot, "scripts", "public-safety-scan.mjs"), workerRoot], {
    encoding: "utf8",
  });
  assert.equal(packCheck.status, 0, packCheck.stdout || packCheck.stderr);

  // Synthetic state must not appear under plugins/
  const leak = join(workerRoot, "plugins", "amadeus", "coordinator.sqlite");
  assert.equal(existsSync(leak), false);
});

test("CLI inspect emits public-safe JSON without applying", () => {
  const f = synthFixture("cli");
  writeMachineConfig({ setupRoot: f.dir, stateRoot: f.source }, f.configPath);
  const reportPath = join(f.dir, "report.json");
  const cli = spawnSync(process.execPath, [
    join(workerRoot, "plugins", "amadeus", "scripts", "migrate-state.mjs"),
    "inspect",
    "--config", f.configPath,
    "--setup-root", f.dir,
    "--report", reportPath,
  ], { encoding: "utf8", env: { ...process.env, LOCALAPPDATA: join(f.dir, "Local") } });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(parsed.command, "inspect");
  assert.equal(typeof parsed.report.shareStableDataRoot, "boolean");
  assertNoPersonalLeak(JSON.stringify(parsed), "cli-report");
  assert.equal(existsSync(join(f.dir, "Local", "Amadeus", "coordinator.sqlite")), false);
  rmSync(f.dir, { recursive: true, force: true });
});

test("compareInventories classifies identical, source-only, and conflict rows", () => {
  const f = synthFixture("cmp");
  mkdirSync(f.target, { recursive: true });
  cpSync(join(f.source, "preferences.json"), join(f.target, "preferences.json"));
  synthDatabase(join(f.target, "coordinator.sqlite"), "OTHER\n");
  const cmp = compareInventories(inventoryStateRoot(f.source), inventoryStateRoot(f.target));
  assert.ok(cmp.identical.some((r) => r.name === "preferences.json"));
  assert.ok(cmp.conflicts.some((r) => r.name === "coordinator.sqlite"));
  assert.ok(cmp.sourceOnly.some((r) => r.name === "goal-packages"));
  assert.equal(verifyMigration({ sourceRoot: f.source, targetRoot: f.target }).ok, false);
  rmSync(f.dir, { recursive: true, force: true });
});

test("defaultCanonicalStateRoot prefers AMADEUS_HOME then Local/Amadeus", () => {
  const home = join(tmpdir(), "amadeus-home-override");
  assert.equal(defaultCanonicalStateRoot({ AMADEUS_HOME: home }), home);
  const local = join(tmpdir(), "local-app");
  const canonical = defaultCanonicalStateRoot({ LOCALAPPDATA: local });
  assert.equal(canonical, join(local, "Amadeus"));
});
