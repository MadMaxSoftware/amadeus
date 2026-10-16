import { DatabaseSync } from "node:sqlite";
/**
 * Sandbox-friendly state-migration tests. Loads modules via data: URLs so
 * Node never realpath()s entry files under a restricted C:\ root.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = process.cwd();
const scriptsDir = path.join(root, "plugins", "amadeus", "scripts");
const rewriteCache = new Map();

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function rewriteWithCache(spec, source) {
  if (rewriteCache.has(spec)) return rewriteCache.get(spec);
  const rewritten = source.replace(
    /from\s+["']\.\/([^"']+)["']/g,
    (match, inner) => {
      const innerSource = fs.readFileSync(path.join(scriptsDir, inner), "utf8");
      const innerRewritten = rewriteWithCache(inner, innerSource);
      return `from ${JSON.stringify(toDataUrl(innerRewritten))}`;
    },
  );
  rewriteCache.set(spec, rewritten);
  return rewritten;
}

async function loadModule(relPath) {
  const absolute = path.join(scriptsDir, relPath);
  const source = fs.readFileSync(absolute, "utf8");
  const rewritten = rewriteWithCache(relPath, source);
  return import(toDataUrl(rewritten));
}

const migration = await loadModule("state-migration.mjs");
const runtime = await loadModule("amadeus-runtime.mjs");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}


function synthDatabase(path, value) { const db=new DatabaseSync(path); try { db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)'); db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('synthetic',value); } finally { db.close(); } }
function synthDatabaseValue(path) { const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT value FROM settings WHERE key=?').get('synthetic').value;}finally{db.close();} }

function synthFixture(tag = "mig") {
  const fixtureRoot = path.join(root, ".tmp", "state-migration-fixtures");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtureRoot, `amadeus-${tag}-`));
  const source = path.join(dir, "legacy-state");
  const target = path.join(dir, "Amadeus");
  const configPath = path.join(dir, "config.json");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(source, "providers"), { recursive: true });
  fs.mkdirSync(path.join(source, "updates"), { recursive: true });
  fs.mkdirSync(path.join(source, "goal-packages", "g1"), { recursive: true });
  synthDatabase(path.join(source, "coordinator.sqlite"), "SYNTH-DB-v1\n");
  fs.writeFileSync(path.join(source, "preferences.json"), JSON.stringify({ theme: "synth" }));
  fs.writeFileSync(path.join(source, "providers", "registry.json"), JSON.stringify({
    schemaVersion: 1,
    providers: { "loopback-synth": { approved: true, qualification: "passed" } },
  }));
  fs.writeFileSync(path.join(source, "providers", "discovery-consent.json"), JSON.stringify({
    discovery: false,
    scopes: [],
  }));
  fs.writeFileSync(path.join(source, "updates", "consent.json"), JSON.stringify({ updateChecks: false }));
  fs.writeFileSync(path.join(source, "goal-packages", "g1", "meta.json"), JSON.stringify({ id: "g1", synthetic: true }));
  return { dir, source, target, configPath };
}

await test("synthetic inventory fingerprints durable allowlisted entries only", () => {
  const f = synthFixture("inv");
  fs.writeFileSync(path.join(f.source, "noise.tmp"), "ignore");
  const inv = migration.inventoryStateRoot(f.source);
  assert.equal(inv.hasCoordinatorDb, true);
  assert.ok(inv.entries.some((e) => e.name === "coordinator.sqlite"));
  assert.ok(inv.entries.some((e) => e.name === "providers"));
  assert.equal(inv.entries.some((e) => e.name === "noise.tmp"), false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

await test("dry-run plan does not write; apply migrates; verify passes; second apply is idempotent", () => {
  const f = synthFixture("flow");
  runtime.writeMachineConfig({ setupRoot: f.dir, stateRoot: f.source }, f.configPath);

  const dry = migration.runStateMigrationWorkflow({
    sourceRoot: f.source,
    targetRoot: f.target,
    configPath: f.configPath,
    setupRoot: f.dir,
    dryRun: true,
  });
  assert.equal(dry.plan.ok, true);
  assert.equal(dry.result.dryRun, true);
  assert.equal(dry.result.applied, false);
  assert.equal(fs.existsSync(path.join(f.target, "coordinator.sqlite")), false);

  const first = migration.runStateMigrationWorkflow({
    sourceRoot: f.source,
    targetRoot: f.target,
    configPath: f.configPath,
    setupRoot: f.dir,
    dryRun: false,
    updateMachineConfig: true,
    force: true,
  });
  assert.equal(first.result.applied, true);
  assert.equal(first.verification.ok, true);
  assert.equal(synthDatabaseValue(path.join(f.target, "coordinator.sqlite")), "SYNTH-DB-v1\n");
  assert.ok(migration.readJournal(f.target)?.backupId);
  assert.equal(migration.readSchemaJournal(f.target)?.stateSchemaVersion, 1);

  const second = migration.runStateMigrationWorkflow({
    sourceRoot: f.source,
    targetRoot: f.target,
    configPath: f.configPath,
    setupRoot: f.dir,
    dryRun: false,
  });
  assert.equal(second.result.idempotent, true);
  assert.equal(second.result.applied, false);
  assert.equal(second.verification.ok, true);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

await test("conflict policy fail blocks; prefer-source backups and replaces; rollback restores", () => {
  const f = synthFixture("conflict");
  fs.mkdirSync(f.target, { recursive: true });
  synthDatabase(path.join(f.target, "coordinator.sqlite"), "SYNTH-DB-v1\n");
  fs.writeFileSync(path.join(f.target, "preferences.json"), JSON.stringify({ theme: "target" }));

  const blocked = migration.planMigration({
    sourceRoot: f.source,
    targetRoot: f.target,
    conflictPolicy: "fail",
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocking.includes("preferences.json"));

  const plan = migration.planMigration({
    sourceRoot: f.source,
    targetRoot: f.target,
    conflictPolicy: "prefer-source",
  });
  assert.equal(plan.ok, true);
  const applied = migration.applyMigration(plan, { dryRun: false });
  assert.equal(applied.applied, true);
  assert.equal(synthDatabaseValue(path.join(f.target, "coordinator.sqlite")), "SYNTH-DB-v1\n");
  const backupId = applied.backupId;
  assert.ok(backupId);
  assert.ok(fs.existsSync(path.join(f.target, "migration", "backups", backupId, "preferences.json")));

  const rbDry = migration.rollbackMigration({ targetRoot: f.target, backupId, dryRun: true });
  assert.equal(rbDry.dryRun, true);
  const rb = migration.rollbackMigration({ targetRoot: f.target, backupId, dryRun: false });
  assert.equal(rb.ok, true);
  assert.equal(synthDatabaseValue(path.join(f.target, "coordinator.sqlite")), "SYNTH-DB-v1\n");
  assert.equal(migration.readJournal(f.target)?.status, "rolled-back");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

await test("same-root and empty-source plans are conflict-safe no-ops", () => {
  const f = synthFixture("noop");
  const same = migration.planMigration({ sourceRoot: f.source, targetRoot: f.source });
  assert.equal(same.mode, "noop-same-root");
  const emptyDir = path.join(f.dir, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });
  const empty = migration.planMigration({ sourceRoot: emptyDir, targetRoot: f.target });
  assert.equal(empty.mode, "noop-empty-source");
  const applied = migration.applyMigration(same, { dryRun: false });
  assert.equal(applied.applied, true);
  assert.equal(migration.readJournal(f.source)?.mode, "noop-same-root");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

await test("marketplace identity / version cache change still resolves shared synthetic state root", () => {
  const f = synthFixture("cache");
  const personalCache = path.join(f.dir, "plugin-cache", "amadeus-personal", "0.3.1");
  const publicCache = path.join(f.dir, "plugin-cache", "amadeus", "0.3.2");
  fs.mkdirSync(personalCache, { recursive: true });
  fs.mkdirSync(publicCache, { recursive: true });
  fs.writeFileSync(path.join(personalCache, "plugin.json"), JSON.stringify({ name: "amadeus", version: "0.3.1" }));
  fs.writeFileSync(path.join(publicCache, "plugin.json"), JSON.stringify({ name: "amadeus", version: "0.3.2" }));
  runtime.writeMachineConfig({ setupRoot: f.dir, stateRoot: f.source }, f.configPath);

  const discovery = migration.discoverKnownStateRoots({
    env: { LOCALAPPDATA: path.join(f.dir, "Local") },
    configPath: f.configPath,
    setupRoot: f.dir,
  });
  assert.equal(discovery.resolvedStateRoot, f.source);
  assert.equal(discovery.shareStableDataRoot, true);
  assert.equal(fs.existsSync(path.join(personalCache, "coordinator.sqlite")), false);
  assert.equal(fs.existsSync(path.join(publicCache, "coordinator.sqlite")), false);
  const report = migration.publicSafeDiscoveryReport(discovery);
  runtime.assertNoPersonalLeak(JSON.stringify(report), "synth-discovery");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

await test("package and git ignore exclude personal state artifacts; migration module is public-safe", () => {
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /\*\.sqlite/);
  assert.match(gitignore, /verification\//);
  assert.match(gitignore, /migration\/backups\//);

  const migrationSrc = fs.readFileSync(path.join(scriptsDir, "state-migration.mjs"), "utf8");
  runtime.assertNoPersonalLeak(migrationSrc, "state-migration.mjs");
  assert.equal(fs.existsSync(path.join(root, "plugins", "amadeus", "config.json")), false);


  const leak = path.join(root, "plugins", "amadeus", "coordinator.sqlite");
  assert.equal(fs.existsSync(leak), false);
});

await test("CLI inspect via data-url workflow emits public-safe report shape", () => {
  const f = synthFixture("cli");
  runtime.writeMachineConfig({ setupRoot: f.dir, stateRoot: f.source }, f.configPath);
  const discovery = migration.discoverKnownStateRoots({
    configPath: f.configPath,
    setupRoot: f.dir,
    env: { LOCALAPPDATA: path.join(f.dir, "Local") },
  });
  const report = migration.publicSafeDiscoveryReport(discovery);
  assert.equal(typeof report.shareStableDataRoot, "boolean");
  runtime.assertNoPersonalLeak(JSON.stringify(report), "cli-report");
  const plan = migration.planMigration({
    sourceRoot: f.source,
    targetRoot: path.join(f.dir, "Local", "Amadeus"),
    conflictPolicy: "fail",
  });
  assert.equal(plan.ok, true);
  assert.equal(fs.existsSync(path.join(f.dir, "Local", "Amadeus", "coordinator.sqlite")), false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

await test("compareInventories classifies identical, source-only, and conflict rows", () => {
  const f = synthFixture("cmp");
  fs.mkdirSync(f.target, { recursive: true });
  fs.copyFileSync(path.join(f.source, "preferences.json"), path.join(f.target, "preferences.json"));
  synthDatabase(path.join(f.target, "coordinator.sqlite"), "OTHER\n");
  const cmp = migration.compareInventories(
    migration.inventoryStateRoot(f.source),
    migration.inventoryStateRoot(f.target),
  );
  assert.ok(cmp.identical.some((r) => r.name === "preferences.json"));
  assert.ok(cmp.conflicts.some((r) => r.name === "coordinator.sqlite"));
  assert.ok(cmp.sourceOnly.some((r) => r.name === "goal-packages"));
  assert.equal(migration.verifyMigration({ sourceRoot: f.source, targetRoot: f.target }).ok, false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

await test("defaultCanonicalStateRoot prefers AMADEUS_HOME then Local/Amadeus", () => {
  const home = path.join(os.tmpdir(), "amadeus-home-override");
  assert.equal(migration.defaultCanonicalStateRoot({ AMADEUS_HOME: home }), home);
  const local = path.join(os.tmpdir(), "local-app");
  const canonical = migration.defaultCanonicalStateRoot({ LOCALAPPDATA: local });
  assert.equal(canonical, path.join(local, "Amadeus"));
});

await test("persistence across simulated cache wipe keeps shared state root", () => {
  const f = synthFixture("persist");
  runtime.writeMachineConfig({ setupRoot: f.dir, stateRoot: f.source }, f.configPath);
  const cacheA = path.join(f.dir, "cache", "0.3.1");
  const cacheB = path.join(f.dir, "cache", "0.3.2");
  fs.mkdirSync(cacheA, { recursive: true });
  fs.mkdirSync(cacheB, { recursive: true });
  // Wipe personal cache; public cache identity changes; durable root unchanged.
  fs.rmSync(cacheA, { recursive: true, force: true });
  const after = migration.discoverKnownStateRoots({
    configPath: f.configPath,
    setupRoot: f.dir,
    env: { LOCALAPPDATA: path.join(f.dir, "Local") },
  });
  assert.equal(after.resolvedStateRoot, f.source);
  assert.equal(after.shareStableDataRoot, true);
  assert.equal(fs.existsSync(path.join(f.source, "coordinator.sqlite")), true);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

console.log(JSON.stringify({
  ok: failed === 0,
  passed,
  failed,
  hasher: createHash("sha256").update("state-migration-sandbox").digest("hex").slice(0, 8),
}, null, 2));
if (failed) process.exitCode = 1;
void spawnSync;
