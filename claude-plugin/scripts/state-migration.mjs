/**
 * Public-safe durable state migration for Amadeus.
 *
 * Moves per-machine goals, preferences, consent, provider approvals /
 * qualification, and coordinator continuity out of versioned plugin caches
 * into a stable state root. Inspects only known Amadeus/plugin locations.
 * Never transmits data. Reports redact absolute paths.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { databaseFingerprint, snapshotDatabase } from "./state-consolidation.mjs";
import {
  assertNoPersonalLeak,
  defaultMachineConfigPath,
  loadMachineConfig,
  resolveStateRoot,
  writeMachineConfig,
} from "./amadeus-runtime.mjs";

export const STATE_SCHEMA_VERSION = 1;
export const MIGRATION_DIR = "migration";
export const JOURNAL_NAME = "journal.json";
export const SCHEMA_JOURNAL_NAME = "schema-journal.json";
export const BACKUPS_DIR = "backups";

/** Allowlisted durable entries relative to a state root. */
export const DURABLE_ENTRIES = Object.freeze([
  "coordinator.sqlite",
  "goal-packages",
  "goal-runs",
  "active-goal-runs",
  "patches",
  "project-checkpoints",
  "retired-goal-run-locks",
  "reconciliation-backups",
  "software-runtime-homes",
  "providers",
  "updates",
  "preferences.json",
  "worker-source-manifest.json",
  "runtime-config",
]);

export function defaultCanonicalStateRoot(env = process.env) {
  if (env.AMADEUS_HOME?.trim()) return resolve(env.AMADEUS_HOME.trim());
  return join(localAppDataFrom(env), "Amadeus");
}

function localAppDataFrom(env) {
  return env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
}

export function redactPath(absolutePath, roots = []) {
  if (!absolutePath) return null;
  const resolved = resolve(String(absolutePath));
  for (const root of roots) {
    if (!root) continue;
    const base = resolve(String(root));
    if (resolved === base) return "<state-root>";
    if (resolved.startsWith(base + sep) || resolved.startsWith(base + "/")) {
      return `<state-root>/${relative(base, resolved).replaceAll("\\", "/")}`;
    }
  }
  const home = homedir();
  if (resolved === home) return "<home>";
  if (resolved.startsWith(home + sep) || resolved.startsWith(home + "/")) {
    const rel = relative(home, resolved).replaceAll("\\", "/");
    return `<home>/${rel}`;
  }
  return `<path:${createHash("sha256").update(resolved).digest("hex").slice(0, 12)}>`;
}

function fingerprintFile(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  const st = statSync(filePath);
  return { kind: "file", sha256: hash.digest("hex"), bytes: st.size };
}

function fingerprintTree(dirPath) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error("Linked durable artifacts require explicit review.");
      if (st.isDirectory()) {
        hash.update(`D:${name}\n`);
        walk(full);
      } else if (st.isFile()) {
        files += 1;
        bytes += st.size;
        hash.update(`F:${name}:${st.size}:`);
        hash.update(readFileSync(full));
        hash.update("\n");
      }
    }
  };
  walk(dirPath);
  return { kind: "dir", sha256: hash.digest("hex"), files, bytes };
}

export function inventoryStateRoot(stateRoot, options = {}) {
  const root = resolve(String(stateRoot));
  const entries = [];
  if (!existsSync(root)) {
    return { root, exists: false, entries, hasCoordinatorDb: false };
  }
  for (const name of DURABLE_ENTRIES) {
    const full = join(root, name);
    if (!existsSync(full)) continue;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) throw new Error("Linked durable entries require explicit review.");
    entries.push({
      name,
      type: st.isDirectory() ? "dir" : "file",
      fingerprint: options.fingerprint === false
        ? null
        : (name === "coordinator.sqlite" ? {kind:"sqlite-snapshot",sha256:databaseFingerprint(full)} : st.isDirectory() ? fingerprintTree(full) : fingerprintFile(full)),
    });
  }
  return {
    root,
    exists: true,
    entries,
    hasCoordinatorDb: existsSync(join(root, "coordinator.sqlite")),
  };
}

/**
 * Probe only known Amadeus / plugin configuration and state locations.
 * Never walks the broader filesystem.
 */
export function discoverKnownStateRoots(options = {}) {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultMachineConfigPath();
  const config = options.config ?? loadMachineConfig(configPath);
  const setupRoot = options.setupRoot
    ?? (config?.setupRoot ? resolve(String(config.setupRoot)) : null);
  const canonical = defaultCanonicalStateRoot(env);
  const configured = config?.stateRoot ? resolve(String(config.stateRoot)) : null;
  const setupSibling = setupRoot ? join(resolve(setupRoot), "coordinator-state") : null;

  const candidates = [
    { id: "canonical-amadeus", path: canonical, kind: "canonical" },
    { id: "machine-config-stateRoot", path: configured, kind: "configured" },
    { id: "setup-sibling", path: setupSibling, kind: "setup-sibling" },
  ];

  const seen = new Map();
  const roots = [];
  for (const candidate of candidates) {
    if (!candidate.path) continue;
    const key = resolve(candidate.path).toLowerCase();
    if (seen.has(key)) {
      roots.push({
        ...candidate,
        path: resolve(candidate.path),
        duplicateOf: seen.get(key),
        inventory: inventoryStateRoot(candidate.path, { fingerprint: false }),
        alias: true,
      });
      continue;
    }
    seen.set(key, candidate.id);
    const inventory = inventoryStateRoot(candidate.path, { fingerprint: false });
    roots.push({
      ...candidate,
      path: resolve(candidate.path),
      alias: false,
      present: inventory.exists,
      inventory,
    });
  }

  const resolved = resolveStateRoot({
    config,
    configPath,
    setupRoot: setupRoot ?? undefined,
    stateRoot: options.stateRoot,
  });

  const dbRoots = roots.filter((r) => !r.alias && r.inventory?.hasCoordinatorDb);
  const uniqueDbPaths = new Set(dbRoots.map((r) => resolve(r.path).toLowerCase()));
  const requiresConsolidation = uniqueDbPaths.size > 1;
  const shareStableDataRoot = uniqueDbPaths.size <= 1
    && resolve(resolved).toLowerCase() === (
      uniqueDbPaths.size === 1
        ? [...uniqueDbPaths][0]
        : resolve(configured ?? canonical).toLowerCase()
    );

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    configPath: resolve(configPath),
    canonicalStateRoot: canonical,
    resolvedStateRoot: resolved,
    requiresConsolidation,
    shareStableDataRoot,
    roots,
  };
}

export function compareInventories(sourceInv, targetInv) {
  const sourceMap = new Map(sourceInv.entries.map((e) => [e.name, e]));
  const targetMap = new Map(targetInv.entries.map((e) => [e.name, e]));
  const names = [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort();
  const rows = [];
  for (const name of names) {
    const s = sourceMap.get(name);
    const t = targetMap.get(name);
    if (s && !t) rows.push({ name, status: "source-only", source: s.fingerprint, target: null });
    else if (!s && t) rows.push({ name, status: "target-only", source: null, target: t.fingerprint });
    else if (s.fingerprint.sha256 === t.fingerprint.sha256) {
      rows.push({ name, status: "identical", source: s.fingerprint, target: t.fingerprint });
    } else {
      rows.push({ name, status: "conflict", source: s.fingerprint, target: t.fingerprint });
    }
  }
  return {
    sameRoot: resolve(sourceInv.root).toLowerCase() === resolve(targetInv.root).toLowerCase(),
    rows,
    conflicts: rows.filter((r) => r.status === "conflict"),
    sourceOnly: rows.filter((r) => r.status === "source-only"),
    identical: rows.filter((r) => r.status === "identical"),
  };
}

function journalPaths(stateRoot) {
  const migrationRoot = join(resolve(stateRoot), MIGRATION_DIR);
  return {
    migrationRoot,
    journal: join(migrationRoot, JOURNAL_NAME),
    schemaJournal: join(migrationRoot, SCHEMA_JOURNAL_NAME),
    backups: join(migrationRoot, BACKUPS_DIR),
  };
}

export function readJournal(stateRoot) {
  const { journal } = journalPaths(stateRoot);
  if (!existsSync(journal)) return null;
  try {
    return JSON.parse(readFileSync(journal, "utf8"));
  } catch {
    return null;
  }
}

export function readSchemaJournal(stateRoot) {
  const { schemaJournal } = journalPaths(stateRoot);
  if (!existsSync(schemaJournal)) return null;
  try {
    return JSON.parse(readFileSync(schemaJournal, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertNoPersonalLeak(text, relative(process.cwd(), filePath) || filePath);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, filePath);
}

/**
 * @param {"fail"|"keep-target"|"prefer-source"} conflictPolicy
 */
export function planMigration(options = {}) {
  const sourceRoot = resolve(String(options.sourceRoot));
  const targetRoot = resolve(String(options.targetRoot ?? defaultCanonicalStateRoot()));
  const conflictPolicy = options.conflictPolicy ?? "fail";
  const sourceInv = inventoryStateRoot(sourceRoot);
  const targetInv = inventoryStateRoot(targetRoot);
  const comparison = compareInventories(sourceInv, targetInv);
  const actions = [];

  if (comparison.sameRoot) {
    return {
      ok: true,
      mode: "noop-same-root",
      dryRun: true,
      sourceRoot,
      targetRoot,
      conflictPolicy,
      actions: [],
      comparison,
      reason: "Source and target resolve to the same directory; no copy required.",
    };
  }

  if (!sourceInv.exists || sourceInv.entries.length === 0) {
    return {
      ok: true,
      mode: "noop-empty-source",
      dryRun: true,
      sourceRoot,
      targetRoot,
      conflictPolicy,
      actions: [],
      comparison,
      reason: "Source has no durable entries.",
    };
  }

  for (const row of comparison.rows) {
    if (row.status === "identical") {
      actions.push({ op: "skip-identical", name: row.name });
    } else if (row.status === "source-only") {
      actions.push({ op: "copy", name: row.name, from: join(sourceRoot, row.name), to: join(targetRoot, row.name) });
    } else if (row.status === "target-only") {
      actions.push({ op: "keep-target", name: row.name });
    } else if (row.status === "conflict") {
      if (row.name === "coordinator.sqlite" || conflictPolicy === "fail") {
        actions.push({ op: "conflict-fail", name: row.name });
      } else if (conflictPolicy === "keep-target") {
        actions.push({ op: "skip-conflict-keep-target", name: row.name });
      } else if (conflictPolicy === "prefer-source") {
        actions.push({
          op: "replace-with-backup",
          name: row.name,
          from: join(sourceRoot, row.name),
          to: join(targetRoot, row.name),
        });
      } else {
        throw new Error(`Unknown conflictPolicy: ${conflictPolicy}`);
      }
    }
  }

  const blocking = actions.filter((a) => a.op === "conflict-fail");
  return {
    ok: blocking.length === 0,
    mode: blocking.length ? "blocked-conflict" : "migrate",
    dryRun: true,
    sourceRoot,
    targetRoot,
    conflictPolicy,
    actions,
    comparison,
    blocking: blocking.map((b) => b.name),
    reason: blocking.length
      ? `Conflict on: ${blocking.map((b) => b.name).join(", ")}`
      : "Ready to migrate allowlisted durable entries.",
  };
}

function copyEntry(from, to) {
  const st = statSync(from);
  mkdirSync(dirname(to), { recursive: true });
  if (from.endsWith("coordinator.sqlite")) {
    if (existsSync(to) || existsSync(`${to}-wal`) || existsSync(`${to}-shm`)) throw new Error("Database replacement requires reviewed consolidation.");
    snapshotDatabase(from,to);
    return;
  }
  if (st.isDirectory()) {
    cpSync(from, to, { recursive: true, force: true });
  } else {
    copyFileSync(from, to);
  }
}

function backupEntry(backupRoot, name, fromPath) {
  const dest = join(backupRoot, name);
  mkdirSync(dirname(dest), { recursive: true });
  copyEntry(fromPath, dest);
  return dest;
}

export function applyMigration(plan, options = {}) {
  const dryRun = options.dryRun !== false; // default dry-run-first
  if (dryRun) {
    return {
      ...plan,
      dryRun: true,
      applied: false,
      message: "Dry-run only; no files written.",
    };
  }
  if (!plan.ok) {
    return { ...plan, dryRun: false, applied: false, message: plan.reason };
  }
  if (plan.mode === "noop-same-root" || plan.mode === "noop-empty-source") {
    const paths = journalPaths(plan.targetRoot);
    mkdirSync(paths.migrationRoot, { recursive: true });
    const journal = {
      schemaVersion: STATE_SCHEMA_VERSION,
      status: "complete",
      mode: plan.mode,
      completedAt: new Date().toISOString(),
      sourceLabel: redactPath(plan.sourceRoot, [plan.sourceRoot, plan.targetRoot]),
      targetLabel: redactPath(plan.targetRoot, [plan.sourceRoot, plan.targetRoot]),
      actions: [],
      idempotent: true,
    };
    writeJsonAtomic(paths.journal, journal);
    writeJsonAtomic(paths.schemaJournal, {
      schemaVersion: STATE_SCHEMA_VERSION,
      updatedAt: journal.completedAt,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      notes: "Durable Amadeus state root schema journal.",
    });
    return { ...plan, dryRun: false, applied: true, journal, message: "No-op migration recorded." };
  }

  const paths = journalPaths(plan.targetRoot);
  mkdirSync(paths.backups, { recursive: true });
  const backupId = `backup-${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}-${process.pid}`;
  const backupRoot = join(paths.backups, backupId);
  mkdirSync(backupRoot, { recursive: true });

  const executed = [];
  try {
    for (const action of plan.actions) {
      if (action.op === "skip-identical" || action.op === "keep-target" || action.op === "skip-conflict-keep-target") {
        executed.push({ ...action, result: "skipped" });
        continue;
      }
      if (action.op === "copy") {
        copyEntry(action.from, action.to);
        executed.push({ op: action.op, name: action.name, result: "copied" });
        continue;
      }
      if (action.op === "replace-with-backup") {
        if (existsSync(action.to)) backupEntry(backupRoot, action.name, action.to);
        copyEntry(action.from, action.to);
        executed.push({ op: action.op, name: action.name, result: "replaced" });
      }
    }

    if (options.updateMachineConfig) {
      const configPath = options.configPath ?? defaultMachineConfigPath();
      const existing = loadMachineConfig(configPath) ?? {};
      const written = writeMachineConfig({
        stateRoot: plan.targetRoot,
        developerMode: false,
        runtimeAuthority: "packaged",
        // Preserve stale setupRoot only as a non-authoritative migration hint.
        legacySetupRootHint: options.setupRoot ?? existing.legacySetupRootHint ?? existing.setupRoot ?? undefined,
        setupRoot: undefined,
      }, configPath);
      executed.push({ op: "update-machine-config", result: "written", schemaVersion: written.schemaVersion });
    }

    const journal = {
      schemaVersion: STATE_SCHEMA_VERSION,
      status: "complete",
      mode: plan.mode,
      backupId,
      completedAt: new Date().toISOString(),
      sourceLabel: redactPath(plan.sourceRoot, [plan.sourceRoot, plan.targetRoot]),
      targetLabel: redactPath(plan.targetRoot, [plan.sourceRoot, plan.targetRoot]),
      conflictPolicy: plan.conflictPolicy,
      actions: executed,
      rollback: {
        backupId,
        backupLabel: `<state-root>/${MIGRATION_DIR}/${BACKUPS_DIR}/${backupId}`,
      },
    };
    writeJsonAtomic(paths.journal, journal);
    const schemaSafe = {
      schemaVersion: STATE_SCHEMA_VERSION,
      updatedAt: journal.completedAt,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      lifecycleRelative: {
        updatesRoot: "updates",
        providersRoot: "providers",
        updateConsent: "updates/consent.json",
        discoveryConsent: "providers/discovery-consent.json",
        providerRegistry: "providers/registry.json",
      },
      notes: "Durable Amadeus state root schema journal.",
    };
    writeJsonAtomic(paths.schemaJournal, schemaSafe);

    return {
      ...plan,
      dryRun: false,
      applied: true,
      backupId,
      journal,
      message: "Migration applied with backup metadata.",
    };
  } catch (error) {
    const failed = {
      schemaVersion: STATE_SCHEMA_VERSION,
      status: "failed",
      backupId,
      failedAt: new Date().toISOString(),
      error: "migration-operation-failed",
      actions: executed,
    };
    try { writeJsonAtomic(paths.journal, failed); } catch { /* best effort */ }
    throw error;
  }
}

export function verifyMigration(options = {}) {
  const sourceRoot = resolve(String(options.sourceRoot));
  const targetRoot = resolve(String(options.targetRoot));
  const comparison = compareInventories(inventoryStateRoot(sourceRoot), inventoryStateRoot(targetRoot));
  const journal = readJournal(targetRoot);
  const schemaJournal = readSchemaJournal(targetRoot);
  const required = (options.requireNames ?? comparison.sourceOnly.map((r) => r.name)
    .concat(comparison.identical.map((r) => r.name)));
  // After successful migrate, source-only should be empty when prefer-source/copy completed;
  // verify that every source entry is identical on target (unless keep-target conflicts).
  const sourceInv = inventoryStateRoot(sourceRoot);
  const targetInv = inventoryStateRoot(targetRoot);
  const missing = [];
  const mismatched = [];
  for (const entry of sourceInv.entries) {
    const t = targetInv.entries.find((e) => e.name === entry.name);
    if (!t) missing.push(entry.name);
    else if (t.fingerprint.sha256 !== entry.fingerprint.sha256) mismatched.push(entry.name);
  }
  const ok = missing.length === 0
    && (options.allowMismatched?.length
      ? mismatched.every((n) => options.allowMismatched.includes(n))
      : mismatched.length === 0);
  return {
    ok,
    sameRoot: comparison.sameRoot,
    missing,
    mismatched,
    journalStatus: journal?.status ?? null,
    schemaVersion: schemaJournal?.stateSchemaVersion ?? null,
    comparison,
  };
}

export function rollbackMigration(options = {}) {
  const targetRoot = resolve(String(options.targetRoot));
  const paths = journalPaths(targetRoot);
  const journal = options.journal ?? readJournal(targetRoot);
  if (!journal?.backupId && !options.backupId) {
    return { ok: false, message: "No backupId available for rollback." };
  }
  const backupId = options.backupId ?? journal.backupId;
  if (!/^backup-[A-Za-z0-9_-]+$/.test(backupId)) return { ok: false, message: "Invalid backup identifier." };
  const backupRoot = join(paths.backups, backupId);
  if (!existsSync(backupRoot)) {
    return { ok: false, message: "Backup directory missing.", backupId };
  }
  if (options.dryRun !== false) {
    return {
      ok: true,
      dryRun: true,
      backupId,
      entries: readdirSync(backupRoot),
      message: "Dry-run rollback; no files restored.",
    };
  }
  const restored = [];
  for (const name of readdirSync(backupRoot)) {
    const from = join(backupRoot, name);
    const to = join(targetRoot, name);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    copyEntry(from, to);
    restored.push(name);
  }
  const updated = {
    ...(journal ?? {}),
    status: "rolled-back",
    rolledBackAt: new Date().toISOString(),
    restored,
  };
  writeJsonAtomic(paths.journal, updated);
  return { ok: true, dryRun: false, backupId, restored, journal: updated };
}

/**
 * Idempotent high-level workflow: inspect → plan → optional apply → verify.
 */
export function runStateMigrationWorkflow(options = {}) {
  const discovery = options.discovery ?? discoverKnownStateRoots(options);
  if (discovery.requiresConsolidation) {
    throw new Error("Multiple coordinator histories detected; preserve every root and use an explicit consolidation workflow before cutover.");
  }
  const sourceRoot = resolve(String(
    options.sourceRoot
    ?? discovery.roots.find((r) => r.inventory.hasCoordinatorDb)?.path
    ?? discovery.resolvedStateRoot,
  ));
  const targetRoot = resolve(String(options.targetRoot ?? discovery.canonicalStateRoot));
  const plan = planMigration({
    sourceRoot,
    targetRoot,
    conflictPolicy: options.conflictPolicy ?? "fail",
  });

  // Idempotency: if journal complete and verify ok, short-circuit.
  const prior = readJournal(targetRoot);
  if (prior?.status === "complete" && !options.force) {
    const verification = verifyMigration({ sourceRoot, targetRoot, allowMismatched: options.allowMismatched });
    if (verification.ok || plan.mode === "noop-same-root") {
      return {
        discovery,
        plan,
        result: {
          ...plan,
          dryRun: options.dryRun !== false,
          applied: false,
          idempotent: true,
          message: "Already migrated; idempotent no-op.",
        },
        verification,
      };
    }
  }

  const result = applyMigration(plan, {
    dryRun: options.dryRun !== false,
    updateMachineConfig: options.updateMachineConfig === true,
    configPath: options.configPath,
    setupRoot: options.setupRoot,
  });
  const verification = result.applied && !result.dryRun
    ? verifyMigration({ sourceRoot, targetRoot, allowMismatched: options.allowMismatched })
    : (options.dryRun === false ? verifyMigration({ sourceRoot, targetRoot, allowMismatched: options.allowMismatched }) : null);

  return { discovery, plan, result, verification };
}

export function publicSafeDiscoveryReport(discovery) {
  const roots = discovery.roots.map((r) => ({
    id: r.id,
    kind: r.kind,
    alias: Boolean(r.alias),
    present: Boolean(r.present ?? r.inventory?.exists),
    hasCoordinatorDb: Boolean(r.inventory?.hasCoordinatorDb),
    entryCount: r.inventory?.entries?.length ?? 0,
    entryNames: (r.inventory?.entries ?? []).map((e) => e.name),
    pathLabel: redactPath(r.path, [discovery.canonicalStateRoot, discovery.resolvedStateRoot]),
  }));
  const report = {
    schemaVersion: STATE_SCHEMA_VERSION,
    shareStableDataRoot: discovery.shareStableDataRoot,
    requiresConsolidation: Boolean(discovery.requiresConsolidation),
    canonicalLabel: redactPath(discovery.canonicalStateRoot, [discovery.canonicalStateRoot]),
    resolvedLabel: redactPath(discovery.resolvedStateRoot, [discovery.canonicalStateRoot, discovery.resolvedStateRoot]),
    roots,
  };
  assertNoPersonalLeak(JSON.stringify(report), "state-migration-report");
  return report;
}
