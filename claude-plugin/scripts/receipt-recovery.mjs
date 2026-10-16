/** Worker receipt verification and deterministic recovery of preserved work. */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureWorkerPatch,
  goalPackagePath,
  inspectGoalExecutionPackage,
  parseCodexUsage,
  parseCursorGoalDecision,
  parseCursorResult,
  parseFinalAgentMessage,
  parseGoalDecision,
  resolveWorkerWorkspaceRoot,
  validateManifestSources,
  verifyWorkspace,
} from "./server-runtime.mjs";
import { contained, retrySqliteBusy, sha256, withCoordinator } from "./server-common.mjs";

export function resolveUnrecordedResultArtifact(jobId, attempt, artifactRoot) {
  const expectedCodexResult = contained(artifactRoot, join(artifactRoot, `${jobId}-a${attempt}.result.jsonl`), "result artifact");
  const expectedCursorResult = contained(artifactRoot, join(artifactRoot, `${jobId}-a${attempt}.cursor-result.jsonl`), "Cursor result artifact");
  const existing = [expectedCodexResult, expectedCursorResult].filter((candidate) => existsSync(candidate));
  if (existing.length !== 1) {
    throw new Error(existing.length
      ? "Both fixed Codex and Cursor result artifacts exist; refusing an ambiguous unrecorded receipt"
      : "No fixed Codex or Cursor result artifact exists for the dispatched job attempt");
  }
  return existing[0];
}

export function verifyReceiptWorkspace(workspace, allowWorkingChanges = false, allowMissingWorkspace = false) {
  if (allowMissingWorkspace && !existsSync(workspace)) return null;
  return verifyWorkspace(workspace, { allowWorkingChanges });
}

export function selectReceiptWorkspace(workspaceName, workspaceRoots, pathExists = existsSync) {
  const candidates = [...new Set(workspaceRoots.map((root) =>
    contained(root, join(root, workspaceName), "worker workspace")))];
  const existing = candidates.filter((candidate) => pathExists(candidate));
  if (existing.length > 1) {
    throw new Error("Multiple worker workspaces exist for the same job attempt; refusing ambiguous receipt verification");
  }
  return existing[0] ?? candidates[0];
}

export async function verifyJobReceipt(jobId, paths, allowWorkingChanges = false, allowMissingWorkspace = false) {
  const record = await retrySqliteBusy(() => withCoordinator(paths.database, (c) => {
    const job = c.getJob(jobId);
    return { job, goal: job.goal_id ? c.getGoal(String(job.goal_id)) : null };
  }));
  const { job, goal } = record;
  const attempt = Number(job.attempt_count);
  if (!Number.isSafeInteger(attempt) || attempt <= 0) throw new Error("Job has no dispatched attempt to verify");
  const expectedCodexResult = contained(paths.artifactRoot, join(paths.artifactRoot, `${jobId}-a${attempt}.result.jsonl`), "result artifact");
  const expectedCursorResult = contained(paths.artifactRoot, join(paths.artifactRoot, `${jobId}-a${attempt}.cursor-result.jsonl`), "Cursor result artifact");
  const resultArtifactPath = job.result_artifact_path
    ? contained(paths.artifactRoot, String(job.result_artifact_path), "recorded result artifact")
    : resolveUnrecordedResultArtifact(jobId, attempt, paths.artifactRoot);
  const provider = resultArtifactPath === expectedCursorResult ? "cursor-browser-login"
    : resultArtifactPath === expectedCodexResult ? "codex-chatgpt-signin" : null;
  if (!provider) throw new Error("Recorded result artifact does not match a fixed Codex or Cursor job-attempt path");
  const bytes = await readFile(resultArtifactPath);
  const jsonl = bytes.toString("utf8");
  const events = jsonl.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Result artifact line ${index + 1} is not JSON`); }
  });
  const cursorReceipt = provider === "cursor-browser-login" ? parseCursorResult(jsonl) : null;
  const completedTurns = provider === "cursor-browser-login"
    ? events.filter((event) => event?.type === "result" && event?.subtype === "success" && event?.is_error === false).length
    : events.filter((event) => event?.type === "turn.completed").length;
  if (completedTurns !== 1) throw new Error(`Result artifact must contain exactly one completed ${provider === "cursor-browser-login" ? "Cursor result" : "Codex turn"}`);
  // Cursor subscription usage is retained separately because its cache-read
  // counters do not share Codex credit-accounting semantics.
  const usage = provider === "cursor-browser-login" ? null : parseCodexUsage(jsonl);
  const cursorUsage = cursorReceipt?.usage ?? null;
  const finalMessage = provider === "cursor-browser-login" ? cursorReceipt.result : parseFinalAgentMessage(jsonl);
  let goalDecision = null;
  let goalDecisionError = null;
  try { goalDecision = provider === "cursor-browser-login" ? parseCursorGoalDecision(jsonl) : parseGoalDecision(finalMessage); }
  catch (error) { goalDecisionError = error instanceof Error ? error.message : String(error); }
  const workspaceName = `${jobId}-a${attempt}`;
  const workspaceRoots = [paths.workspaceRoot];
  if (goal?.project_root) {
    workspaceRoots.unshift(resolveWorkerWorkspaceRoot(String(goal.project_root), paths.stateRoot));
  }
  const workspace = selectReceiptWorkspace(workspaceName, workspaceRoots);
  const isolation = verifyReceiptWorkspace(workspace, allowWorkingChanges, allowMissingWorkspace);
  let currentSourceManifest = null;
  let sourceManifestStillMatches = null;
  if (isolation) {
    try {
      currentSourceManifest = validateManifestSources(paths.workerManifest);
      sourceManifestStillMatches = currentSourceManifest.manifestSha256 === isolation.sourceManifestSha256;
    } catch {
      currentSourceManifest = null;
    }
  }
  return {
    jobId,
    attempt,
    jobStatus: job.status,
    provider,
    resultArtifactPath,
    resultArtifactSha256: sha256(bytes),
    resultBytes: bytes.length,
    completedTurns,
    usage,
    cursorUsage,
    finalMessage,
    goalDecision,
    goalDecisionError,
    trustworthyGoalDecision: goalDecision !== null,
    workspace,
    workspaceAvailable: isolation !== null,
    workspaceFiles: isolation?.files.length ?? null,
    workspaceSourceManifestSha256: isolation?.sourceManifestSha256 ?? null,
    sourceManifestStillMatches,
    currentSourceManifestSha256: currentSourceManifest?.manifestSha256 ?? null,
    workspaceDisposition: isolation === null
      ? "historical_workspace_unavailable_nonblocking_for_receipt_audit"
      : "workspace_verified",
    processState: "not-established-by-receipt-verification",
  };
}

export function structuredAuditDetail(event) {
  try {
    const wrapper = JSON.parse(String(event.detail));
    return JSON.parse(String(wrapper.detail));
  } catch { return null; }
}

/** The model a job was actually routed to, from its latest route_selected audit note. */
export function routedModelForJob(coordinator, jobId) {
  const route = coordinator.events(jobId).filter((event) => event.kind === "route_selected").at(-1);
  const model = route ? structuredAuditDetail(route)?.model : null;
  return typeof model === "string" && model.trim() ? model : null;
}

export function goalEventDetail(event) {
  try { return JSON.parse(String(event.detail)); }
  catch { return null; }
}

export function externallyVerifiedReceiptDisposition(job, goalEvents = []) {
  const externalVerification = goalEvents
    .filter((event) => event.kind === "iteration_completed_external_verification")
    .map((event) => goalEventDetail(event))
    .find((detail) => String(detail?.jobId ?? "") === String(job.id)
      && detail?.modelInvokedForReconciliation === false);
  if (!externalVerification) return null;
  return {
    jobId: job.id,
    status: job.status,
    verified: null,
    requiredForCompletedResult: false,
    receiptExpected: false,
    externallyVerifiedCompletion: true,
    modelInvokedForReconciliation: false,
    disposition: "not_applicable_external_verification_without_model_receipt",
  };
}

export function providerExecutionFailed(job) {
  const executions = (job.events ?? []).filter((event) => event.kind === "route_step_completed")
    .map((event) => structuredAuditDetail(event)).filter((detail) => detail?.step === "execute");
  if (executions.length) return executions.at(-1).passed === false;
  return String(job.status) === "uncertain" && Number(job.attempt_count ?? 0) > 0
    && !(job.usage?.providerRecords?.length);
}

export async function promotePreservedCaptureStrategy({ jobId, paths, snapshot, recoveryEvidence }) {
  const goalId = String(snapshot.job.goal_id);
  const stage = inspectGoalExecutionPackage(goalPackagePath(paths.packagesRoot, goalId), goalId,
    Number(snapshot.job.package_stage_iteration ?? snapshot.job.goal_iteration), true);
  if (stage.stage.patchPolicy !== "capture-only" || !Array.isArray(stage.stage.allowedWritableWorkspacePaths)) {
    throw new Error("the selected deterministic strategy requires a preserved capture-only stage");
  }
  const receipt = await verifyJobReceipt(jobId, paths, true);
  if (!receipt.trustworthyGoalDecision || receipt.goalDecision.status !== "continue") throw new Error("saved capture has no trustworthy continuation decision");
  const decision = receipt.goalDecision;
  const patch = captureWorkerPatch(receipt.workspace, stage.stage.allowedWritableWorkspacePaths, paths.artifactRoot, `${jobId}-a${receipt.attempt}`);
  if (!patch) throw new Error("saved workspace contains no capture to recover");
  if (patch.changedFiles > (stage.stage.maximumChangedFiles ?? Infinity) || patch.changedLines > (stage.stage.maximumChangedLines ?? Infinity)) {
    throw new Error("saved capture still exceeds the current package policy");
  }
  return withCoordinator(paths.database, (coordinator) => {
    coordinator.recordAuditNote(jobId, "ordinary_software_recovery", JSON.stringify({
      reason: "Reverified and recovered the preserved capture without repeating the worker model call.",
      avoidedRepeatModelCalls: 1,
      changedFiles: patch.changedFiles,
      changedLines: patch.changedLines,
    }));
    return coordinator.promoteVerifiedGoalIteration({
      jobId,
      recoveryStrategy: recoveryEvidence.recoveryStrategy,
      outcome: "Recovered the verified preserved capture under the current package policy; no authoritative project files were modified.",
      resultArtifactPath: receipt.resultArtifactPath,
      decision,
      patchPath: patch.path,
      patchSha256: patch.sha256,
      patchBytes: patch.bytes,
      changedFiles: patch.changedFiles,
      changedLines: patch.changedLines,
      reason: `Verified preserved result and ${patch.changedFiles}-file/${patch.changedLines}-line capture against the current package policy without another model call.`,
    });
  });
}

export const deterministicRecoveryStrategies = new Map([
  ["promote-preserved-capture", promotePreservedCaptureStrategy],
]);

export async function attemptDeterministicRecoveryForJob(jobId, paths) {
  const snapshot = withCoordinator(paths.database, (coordinator) => {
    const job = coordinator.getJob(jobId);
    if (!job.goal_id) throw new Error("failed work is not part of a persistent goal");
    return { job, goal: coordinator.getGoal(String(job.goal_id)), events: coordinator.events(jobId) };
  });
  const recoveryEvidence = snapshot.events
    .filter((event) => event.kind === "recoverable_failure")
    .map(structuredAuditDetail)
    .find((detail) => detail?.schemaVersion === 1 && typeof detail.recoveryStrategy === "string"
      && detail.authoritativeWorkspaceModified === false);
  if (snapshot.job.status !== "failed" || !recoveryEvidence) return null;
  const strategy = deterministicRecoveryStrategies.get(recoveryEvidence.recoveryStrategy);
  return strategy ? strategy({ jobId, paths, snapshot, recoveryEvidence }) : null;
}

export async function attemptDeterministicRecoveryForGoal(goalId, paths) {
  const candidate = withCoordinator(paths.database, (coordinator) => {
    const goal = coordinator.getGoal(goalId);
    if (goal.status !== "blocked" || !goal.current_job_id) return null;
    const job = coordinator.getJob(String(goal.current_job_id));
    if (job.status !== "failed") return null;
    const recoverable = coordinator.events(String(job.id)).some((event) => {
      const detail = event.kind === "recoverable_failure" ? structuredAuditDetail(event) : null;
      return detail?.schemaVersion === 1 && typeof detail.recoveryStrategy === "string"
        && detail.authoritativeWorkspaceModified === false;
    });
    return recoverable ? String(job.id) : null;
  });
  return candidate ? attemptDeterministicRecoveryForJob(candidate, paths) : null;
}
