/** Lazily loads the coordinator runtime. Bindings are live: importers see them once ensureRuntime() resolves. */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildProductionPaths, pathLooksLikeForeignProject } from "./amadeus-runtime.mjs";

export const execFileAsync = promisify(execFile);
export let productionPaths, setupRoot;
let runtimeLoading;
export let Coordinator, goalPackagePath, inspectGoalExecutionPackage, refreshRepeatGoalPackage, writeDevelopmentManifest, parseCodexUsage, parseFinalAgentMessage, parseCursorGoalDecision, parseCursorResult, parseGoalDecision, validateManifestSources, verifyWorkspace, resolveWorkerWorkspaceRoot, captureWorkerPatch;
export async function ensureRuntime() {
  if (!runtimeLoading) runtimeLoading = (async () => {
    productionPaths = buildProductionPaths({ metaUrl: import.meta.url });
    setupRoot = productionPaths.setupRoot;
    // Packaged runtime may live under a host cache path; only non-packaged
    // source authority is refused when the path looks like a foreign project.
    if (!productionPaths.runtimePackaged
      && pathLooksLikeForeignProject(productionPaths.coordinatorRoot)) {
      throw new Error("Refusing to load Amadeus runtime from a foreign or legacy host tree.");
    }
    const coordinatorModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "coordinator.ts")).href;
    ({ Coordinator } = await import(coordinatorModule));
    const packageModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "goal-execution-package.ts")).href;
    ({ goalPackagePath, inspectGoalExecutionPackage, refreshRepeatGoalPackage } = await import(packageModule));
    ({ writeDevelopmentManifest } = await import(pathToFileURL(join(productionPaths.coordinatorRoot, "src", "development-project.ts")).href));
    const usageModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "usage-accounting.ts")).href;
    ({ parseCodexUsage } = await import(usageModule));
    const codexWorkerModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "codex-worker-driver.ts")).href;
    ({ parseFinalAgentMessage } = await import(codexWorkerModule));
    const cursorWorkerModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "cursor-worker-driver.ts")).href;
    ({ parseCursorGoalDecision } = await import(cursorWorkerModule));
    const cursorAdapterModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "cursor-adapter.ts")).href;
    ({ parseCursorResult } = await import(cursorAdapterModule));
    const goalProtocolModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "goal-protocol.ts")).href;
    ({ parseGoalDecision } = await import(goalProtocolModule));
    const isolationModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "worker-isolation.ts")).href;
    ({ validateManifestSources, verifyWorkspace } = await import(isolationModule));
    ({ resolveWorkerWorkspaceRoot } = await import(pathToFileURL(join(productionPaths.coordinatorRoot, "src", "worker-workspace-root.ts")).href));
    const patchModule = pathToFileURL(join(productionPaths.coordinatorRoot, "src", "worker-patch.ts")).href;
    ({ captureWorkerPatch } = await import(patchModule));
    // Rolling daily backups of the durable goal database. A failed backup must
    // never block coordination; it is retried the next time the server starts.
    try {
      const { runStateBackupIfDue } = await import(pathToFileURL(join(productionPaths.coordinatorRoot, "src", "backup-policy.ts")).href);
      runStateBackupIfDue({ databasePath: productionPaths.database, backupRoot: join(productionPaths.stateRoot, "backups", "state") });
    } catch { /* best effort */ }
  })().catch(error => { runtimeLoading = null; throw error; });
  return runtimeLoading;
}
