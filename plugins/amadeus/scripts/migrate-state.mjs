#!/usr/bin/env node
/**
 * CLI: idempotent dry-run-first Amadeus durable state migration.
 *
 * Commands:
 *   inspect   Compare known Amadeus state locations (read-only)
 *   plan      Emit a migration plan (dry-run)
 *   apply     Apply a plan (requires --execute; default remains dry-run)
 *   verify    Verify source/target durable entries
 *   rollback  Restore from migration backup metadata
 *
 * Never uninstalls plugins. Does not transmit state.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  applyMigration,
  discoverKnownStateRoots,
  planMigration,
  publicSafeDiscoveryReport,
  rollbackMigration,
  runStateMigrationWorkflow,
  verifyMigration,
} from "./state-migration.mjs";
import { assertNoPersonalLeak } from "./amadeus-runtime.mjs";
import { planConsolidation, applyConsolidation, recoverConsolidation } from "./state-consolidation.mjs";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return `Usage: node plugins/amadeus/scripts/migrate-state.mjs <inspect|plan|apply|verify|rollback|consolidate|consolidation-recover|consolidation-rollback> [options]

Options:
  --source-root <path>     Explicit source state root
                          Repeat for consolidate (no automatic discovery)
  --target-root <path>     Explicit target/canonical state root
  --config <path>          Machine config path
  --setup-root <path>      Setup root for config updates
  --conflict-policy <p>    fail | keep-target | prefer-source (default: fail)
  --execute                Actually write (apply/rollback); omit for dry-run
  --update-config          Point machine config stateRoot at target after apply
  --report <path>          Write public-safe JSON report
  --backup-id <id>         Backup id for rollback
  --force                  Re-run even if journal says complete
  --offline                Confirm target coordinators have stopped
  --review-digest <digest>  Reviewed consolidate inputDigest, required to execute
`;
}

const command = process.argv[2] || "inspect";
if (hasFlag("--help") || hasFlag("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

const conflictPolicy = argValue("--conflict-policy") || "fail";
const sourceRoot = argValue("--source-root");
const targetRoot = argValue("--target-root");
const configPath = argValue("--config");
const setupRoot = argValue("--setup-root");
const reportPath = argValue("--report");
const execute = hasFlag("--execute");

let output;
try {
  if (command === "consolidate") {
    const sourceRoots = process.argv.flatMap((arg,index) => arg === "--source-root" ? [process.argv[index+1]] : []);
    const plan = planConsolidation({sourceRoots,targetRoot});
    if(execute && argValue("--review-digest") !== plan.inputDigest) throw new Error("reviewed-digest-required");
    output = {command,plan,result:await applyConsolidation(plan,{dryRun:!execute,quiescent:hasFlag("--offline")})};
  } else if (["consolidation-recover","consolidation-rollback"].includes(command)) {
    if(!targetRoot) throw new Error("explicit-target-required");
    output = {command,result:recoverConsolidation({targetRoot,dryRun:!execute,quiescent:hasFlag("--offline"),rollback:command === "consolidation-rollback"})};
  } else if (command === "inspect") {
    const discovery = discoverKnownStateRoots({ configPath, setupRoot, sourceRoot });
    output = {
      command: "inspect",
      report: publicSafeDiscoveryReport(discovery),
      note: discovery.shareStableDataRoot
        ? "Known locations already share one durable data root for coordinator state."
        : (discovery.requiresConsolidation
          ? "Multiple coordinator histories detected; preserve every root and consolidate before any cutover."
          : "A divergent durable root was detected; run plan before any cutover."),
    };
  } else if (command === "plan") {
    const discovery = discoverKnownStateRoots({ configPath, setupRoot });
    if (discovery.requiresConsolidation) {
      throw new Error("Multiple coordinator histories detected; plan requires an explicit source root and no history will be selected automatically.");
    }
    const src = sourceRoot
      ?? discovery.roots.find((r) => r.kind === "legacy-default" && r.inventory.hasCoordinatorDb)?.path
      ?? discovery.resolvedStateRoot;
    const dst = targetRoot ?? discovery.canonicalStateRoot;
    const plan = planMigration({ sourceRoot: src, targetRoot: dst, conflictPolicy });
    output = {
      command: "plan",
      report: publicSafeDiscoveryReport(discovery),
      plan: {
        ok: plan.ok,
        mode: plan.mode,
        reason: plan.reason,
        conflictPolicy: plan.conflictPolicy,
        actions: plan.actions.map((a) => ({ op: a.op, name: a.name })),
        blocking: plan.blocking ?? [],
        sourceLabel: publicSafeDiscoveryReport(discovery).resolvedLabel,
        targetLabel: publicSafeDiscoveryReport(discovery).canonicalLabel,
      },
    };
  } else if (command === "apply") {
    const workflow = runStateMigrationWorkflow({
      sourceRoot,
      targetRoot,
      configPath,
      setupRoot,
      conflictPolicy,
      dryRun: !execute,
      updateMachineConfig: hasFlag("--update-config"),
      force: hasFlag("--force"),
    });
    output = {
      command: "apply",
      dryRun: !execute,
      report: publicSafeDiscoveryReport(workflow.discovery),
      plan: {
        ok: workflow.plan.ok,
        mode: workflow.plan.mode,
        reason: workflow.plan.reason,
        actions: workflow.plan.actions.map((a) => ({ op: a.op, name: a.name })),
      },
      result: {
        applied: workflow.result.applied,
        idempotent: Boolean(workflow.result.idempotent),
        message: workflow.result.message,
        backupId: workflow.result.backupId ?? null,
      },
      verification: workflow.verification
        ? {
          ok: workflow.verification.ok,
          missing: workflow.verification.missing,
          mismatched: workflow.verification.mismatched,
          journalStatus: workflow.verification.journalStatus,
          schemaVersion: workflow.verification.schemaVersion,
        }
        : null,
    };
  } else if (command === "verify") {
    if (!sourceRoot || !targetRoot) throw new Error("verify requires --source-root and --target-root");
    const verification = verifyMigration({ sourceRoot, targetRoot });
    output = {
      command: "verify",
      verification: {
        ok: verification.ok,
        sameRoot: verification.sameRoot,
        missing: verification.missing,
        mismatched: verification.mismatched,
        journalStatus: verification.journalStatus,
        schemaVersion: verification.schemaVersion,
      },
    };
  } else if (command === "rollback") {
    if (!targetRoot) throw new Error("rollback requires --target-root");
    const result = rollbackMigration({
      targetRoot,
      backupId: argValue("--backup-id"),
      dryRun: !execute,
    });
    output = { command: "rollback", dryRun: !execute, result };
  } else {
    throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
} catch (error) {
  process.exitCode = 1;
  output = { ok: false, error: "migration-refused-use-explicit-reviewed-roots" };
}

const text = `${JSON.stringify(output, null, 2)}\n`;
try {
  assertNoPersonalLeak(text, "migrate-state-output");
} catch (leak) {
  process.stderr.write(`${leak.message}\n`);
  process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ ok: false, error: "refusing to emit personal material" }, null, 2)}\n`);
  process.exit(1);
}

if (reportPath) {
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), text, "utf8");
}
process.stdout.write(text);
if (output?.plan?.ok === false || output?.verification?.ok === false || output?.result?.ok === false) {
  process.exitCode = 2;
}
