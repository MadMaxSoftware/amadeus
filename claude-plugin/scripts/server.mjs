import { dependencyHealth } from "./dependency-health.mjs";
import { discoveryPreview, runDiscovery, viewInventory, deleteInventory } from "./capability-discovery.mjs";
import { onboardingStatus, recordDiscoveryChoice, configureRuntime, setupPackagedRuntime, onboardingInstructions, onboardingToolDefinitions } from "./privacy-onboarding.mjs";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { guardInstalledPluginTarget, writeLocalRepairArtifact } from "./self-repair-boundary.mjs";
import { activeRun, activeRunForGoal, activeRuns, lastRun, launchBackground, runBackground, executeSupervisor, cancelPending, pendingRuns } from "./background-run.mjs";
import { fileURLToPath } from "node:url";
import {
  AMADEUS_PRODUCT,
  buildProductionPaths,
  detectAccelerators,
  pathLooksLikeForeignProject,
  resolveStateRoot,
} from "./amadeus-runtime.mjs";
import {
  approveProvider,
  checkForUpdate,
  declineUpdateConsent,
  defaultDiscoveryPaths,
  defaultRegistryPath,
  defaultUpdatePaths,
  enableProvider,
  grantUpdateConsent,
  loadRegistry,
  marketplaceUpgradeCommandFor,
  readPluginVersion,
  recordDiscovery,
  rescanProviders,
  runLifecycleStatus,
  saveRegistry,
  stableChannelLocalRoutingStatus,
} from "./amadeus-lifecycle.mjs";

const execFileAsync = promisify(execFile);
let productionPaths, setupRoot, runtimeLoading;
let Coordinator, goalPackagePath, inspectGoalExecutionPackage, refreshRepeatGoalPackage, writeDevelopmentManifest, parseCodexUsage, parseFinalAgentMessage, parseCursorGoalDecision, parseCursorResult, parseGoalDecision, validateManifestSources, verifyWorkspace, resolveWorkerWorkspaceRoot, captureWorkerPatch;
async function ensureRuntime() {
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

function object(value, label = "arguments") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value, label, maximum = 20_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${label} is too long`);
  return result;
}

export function validateRoutePin(args) {
  const routeFieldsProvided = args.provider !== undefined || args.model !== undefined || args.reasoningEffort !== undefined;
  if (routeFieldsProvided && args.pinRoute !== true) {
    throw new Error("provider, model, and reasoningEffort require pinRoute=true; omit them for automatic coordinator routing");
  }
  return args.pinRoute === true;
}

export function cursorRoutePreflightProblem({ development, provider, cursorAcceleratorPresent, cursorWorker = {} }) {
  if (!development || provider !== "cursor-browser-login") return null;
  if (!cursorAcceleratorPresent) {
    return "Cursor was requested for this development goal but the optional Cursor accelerator is not installed; use ordinary software plus available Codex/GPT models, or install Cursor.";
  }
  if (cursorWorker.containmentWindowsSandbox !== "mxc" || cursorWorker.containmentProfile !== "cursor_contained"
    || cursorWorker.automaticStartup !== false || cursorWorker.authentication !== "browser-login"
    || cursorWorker.apiKeyAuthenticationAllowed !== false
    || !cursorWorker.isolationAcceptanceHarness || !existsSync(cursorWorker.isolationAcceptanceHarness)
    || !cursorWorker.isolationSecurityStateProbe || !existsSync(cursorWorker.isolationSecurityStateProbe)) {
    return "Cursor automatic route is missing its reviewed MXC containment or per-workspace acceptance preflight";
  }
  return null;
}

function uuid(value, label = "goalId") {
  const result = text(value, label, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new Error(`${label} must be a UUID`);
  }
  return result;
}

export function writableWorkspacePaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("writableWorkspacePaths must be an array");
  const normalized = value.map((item) => {
    const path = text(item, "writableWorkspacePaths item", 500).replaceAll("\\", "/");
    if (path === "*") throw new Error("Unsafe writable workspace path: *");
    if (path === ".") return path;
    const parts = path.split("/");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.some((part) => !part || part === "." || part === "..")
      || parts[0].toLowerCase() === ".git" || path === ".worker-isolation.json") {
      throw new Error(`Unsafe writable workspace path: ${path}`);
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("Duplicate writable workspace path");
  return normalized;
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Optional accelerator configs (Cursor) must not crash startup/preflight when absent. */
async function optionalJsonFile(path, fallback = {}) {
  if (!path || !existsSync(path)) return fallback;
  try {
    return await jsonFile(path);
  } catch {
    return fallback;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

// `inherit` is a UI/configuration sentinel, never a provider model. Automatic
// routing must omit it so the supervisor selects a concrete route.
function normalizeRouteModel(value, { pinned = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const model = String(value).trim();
  if (model.toLowerCase() === "inherit") {
    if (pinned) throw new Error("Invalid pinned model 'inherit'; specify a concrete model or leave routing automatic");
    return null;
  }
  return model;
}

async function createDefaultGoalPackage(goalId, paths, options = {}) {
  const packagePath = goalPackagePath(paths.packagesRoot, goalId);
  if (existsSync(packagePath)) {
    const existing = await jsonFile(packagePath);
    if (existing.mode !== "repeat" || existing.stages?.[0]?.role !== "development") {
      throw new Error("Existing idempotent goal uses a different execution profile");
    }
    if (options.projectRoot && resolve((await jsonFile(join(dirname(packagePath), existing.stages[0].manifest))).source.projectRoot) !== resolve(options.projectRoot)) throw new Error("This goal already belongs to a different project");
    return packagePath;
  }
  const packageRoot = dirname(packagePath);
  await mkdir(packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "source.manifest.json");
  if (typeof options.projectRoot !== "string" || !options.projectRoot.trim()) {
    throw new Error("Absolute projectRoot is required for new ordinary development goals");
  }
  const projectRoot = resolve(options.projectRoot);
  if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be an absolute folder path");
  writeDevelopmentManifest(projectRoot, manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const operations = await jsonFile(paths.operations);
  const descriptor = {
    schemaVersion: 1,
    goalId,
    mode: "repeat",
    developmentMode: true,
    routingMode: options.provider !== undefined || options.model !== undefined ? "pinned" : "automatic",
    provider: options.provider ?? operations.dispatch.provider,
    model: normalizeRouteModel(options.model ?? (options.provider === "cursor-browser-login" ? null : operations.dispatch.model), { pinned: options.provider !== undefined || options.model !== undefined }),
    reasoningEffort: options.reasoningEffort ?? operations.dispatch.reasoningEffort,
    stages: [{
      iteration: 1,
      name: "development",
      role: "development",
      manifest: "source.manifest.json",
      manifestSha256: sha256(manifestBytes),
      objectiveMode: "coordinator",
      allowedWritableWorkspacePaths: "caller-bounded",
      patchPolicy: "apply",
      maximumChangedFiles: null,
      maximumChangedLines: null,
    }],
  };
  await writeFile(packagePath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  return packagePath;
}

function contained(root, candidate, label) {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const relation = relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} is outside its fixed coordinator directory`);
  }
  return resolved;
}

export async function retrySqliteBusy(operation, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return operation(); }
    catch (error) {
      const busy = error?.code === "SQLITE_BUSY" || /database is locked/i.test(String(error?.message ?? error));
      if (!busy || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  throw new Error("SQLite retry loop ended unexpectedly");
}

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

async function verifyJobReceipt(jobId, paths, allowWorkingChanges = false, allowMissingWorkspace = false) {
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

function structuredAuditDetail(event) {
  try {
    const wrapper = JSON.parse(String(event.detail));
    return JSON.parse(String(wrapper.detail));
  } catch { return null; }
}

/** The model a job was actually routed to, from its latest route_selected audit note. */
function routedModelForJob(coordinator, jobId) {
  const route = coordinator.events(jobId).filter((event) => event.kind === "route_selected").at(-1);
  const model = route ? structuredAuditDetail(route)?.model : null;
  return typeof model === "string" && model.trim() ? model : null;
}

function goalEventDetail(event) {
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

async function promotePreservedCaptureStrategy({ jobId, paths, snapshot, recoveryEvidence }) {
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

const deterministicRecoveryStrategies = new Map([
  ["promote-preserved-capture", promotePreservedCaptureStrategy],
]);

async function attemptDeterministicRecoveryForJob(jobId, paths) {
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

async function attemptDeterministicRecoveryForGoal(goalId, paths) {
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

function withCoordinator(database, action) {
  const coordinator = new Coordinator(database);
  try { return action(coordinator); }
  finally { coordinator.close(); }
}

function goalSummary(coordinator, goalId) {
  const goal = coordinator.getGoal(goalId);
  const job = goal.current_job_id ? coordinator.getJob(String(goal.current_job_id)) : null;
  return {
    goal,
    currentJob: job,
    goalEvents: coordinator.goalEvents(goalId),
  };
}

const LIVE_JOB_STATUSES = new Set(["queued", "running", "waiting_question", "uncertain"]);

function liveJobForGoal(coordinator, goal) {
  if (!goal.current_job_id) return null;
  const job = coordinator.getJob(String(goal.current_job_id));
  return LIVE_JOB_STATUSES.has(String(job.status)) ? job : null;
}

function ownerWorkView(coordinator, goalId, includeTechnical = false) {
  const goal = coordinator.getGoal(goalId);
  const currentJob = liveJobForGoal(coordinator, goal);
  const jobs = coordinator.status().jobs.filter((job) => job.goal_id === goalId);
  const usageRecords = jobs.flatMap((job) => coordinator.usage(String(job.id)).records);
  const providerRecords = jobs.flatMap((job) => coordinator.usage(String(job.id)).providerRecords ?? []);
  const estimatedSpent = usageRecords.reduce((sum, record) => sum + Number(record.estimated_credit_micros ?? 0), 0) / 1_000_000;
  const actualRecords = usageRecords.filter((record) => record.actual_provider_credit_micros !== null);
  const actualSpent = actualRecords.length
    ? actualRecords.reduce((sum, record) => sum + Number(record.actual_provider_credit_micros), 0) / 1_000_000
    : null;
  let state = "stopped_by_problem";
  let message = "The work is unfinished and safely preserved while I diagnose a problem.";
  let needsFromYou = null;
  if (goal.status === "completed") {
    state = "finished";
    message = "Finished and recorded as complete with evidence.";
  } else if (goal.status === "waiting_approval") {
    state = "needs_your_decision";
    message = "Work remains unfinished while the specific owner action shown below is needed.";
    needsFromYou = goal.question;
  } else if (goal.status === "blocked" && goal.question?.trim()) {
    state = "needs_your_decision";
    message = "Work remains unfinished while the specific owner action shown below is needed.";
    needsFromYou = goal.question;
  } else if (goal.status === "blocked") {
    if (coordinator.latestGoalDecision(goalId)?.hostHandoff?.action) {
      state = "waiting_on_origin_host";
      message = "The isolated worker finished and saved the host-side step. Execute that approved handoff from the originating turn; do not launch another worker to rediscover it.";
    } else {
      state = "continuing";
      message = "The worker saved an unfinished technical objective. Continue that objective in the same approved scope.";
    }
  } else if (goal.status === "budget_limited") {
    state = "paused";
    message = "This unfinished work was paused by the previous coordinator configuration and remains preserved.";
  } else if (goal.status === "uncertain") {
    state = "checking_what_happened";
    message = "Work is unfinished and preserved while saved evidence is checked. You should not be asked to classify internal job states.";
  } else if (goal.status === "paused" && coordinator.usageLimitResumeAt(goalId)) {
    state = "waiting_for_usage_reset";
    message = `The AI provider's usage limit was reached. The work is saved and resumes automatically after ${coordinator.usageLimitResumeAt(goalId)}.`;
  } else if (goal.status === "paused" && currentJob?.status === "queued") {
    state = "ready_to_start";
    message = "The unfinished work is preserved, prepared, and ready to start when authorized.";
  } else if (goal.status === "paused") {
    state = "paused";
    message = "Work is safely paused and remains on the plan.";
  } else if (goal.status === "active" && currentJob?.status === "running") {
    state = "working";
    message = "Work is in progress.";
  } else if (goal.status === "active") {
    state = "continuing";
    message = "Work is active and will continue within the approved boundary.";
  } else if (goal.status === "stopped") {
    state = "stopped";
    message = "Work was explicitly stopped before completion and remains in the record.";
  }
  const routingHistory = jobs.flatMap((job) => coordinator.events(String(job.id))
    .filter((event) => event.kind === "route_selected")
    .map((event) => {
      const selected = JSON.parse(JSON.parse(String(event.detail)).detail);
      return {
        selectedAt: event.created_at,
        iteration: job.goal_iteration ?? null,
        provider: selected.provider,
        model: selected.model ?? null,
        reasoningEffort: selected.reasoningEffort ?? null,
        reason: selected.reason,
        objective: selected.objective ?? job.iteration_objective ?? goal.objective,
        jobStatus: job.status,
      };
    })).sort((left, right) => String(left.selectedAt).localeCompare(String(right.selectedAt))).slice(-50);
  const routing = routingHistory.at(-1) ?? null;
  const percent = (count, total) => total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
  const stepRoutingHistory = jobs.flatMap((job) => coordinator.events(String(job.id))
    .filter((event) => event.kind === "route_step_completed")
    .map((event) => {
      const step = JSON.parse(JSON.parse(String(event.detail)).detail);
      return {
        completedAt: event.created_at,
        iteration: job.goal_iteration ?? null,
        step: step.step,
        provider: step.provider,
        model: step.model ?? null,
        reasoningEffort: step.reasoningEffort ?? null,
        noModel: step.financialBasis === "no-model",
        passed: step.passed === true,
        reason: step.reason ?? null,
        summary: step.summary ?? null,
      };
    })).sort((left, right) => String(left.completedAt).localeCompare(String(right.completedAt))).slice(-150);
  const stepProviderNames = new Set(stepRoutingHistory.map((entry) => entry.provider));
  const stepProviderBreakdown = [...stepProviderNames].map((provider) => {
    const selected = stepRoutingHistory.filter((entry) => entry.provider === provider);
    return {
      provider,
      completedSteps: selected.length,
      completedStepPercentage: percent(selected.length, stepRoutingHistory.length),
      passedSteps: selected.filter((entry) => entry.passed).length,
      failedSteps: selected.filter((entry) => !entry.passed).length,
    };
  });
  const allocationMap = new Map([
    ["ordinary software", { route: "ordinary software", model: null, reasoningEffort: null, completedSteps: 0 }],
    ["Cursor", { route: "Cursor", model: null, reasoningEffort: null, completedSteps: 0 }],
  ]);
  for (const step of stepRoutingHistory) {
    const key = step.provider === "software"
      ? "ordinary software"
      : step.provider === "cursor-browser-login"
        ? "Cursor"
        : `${step.provider ?? "unidentified provider"} · ${step.model ?? "unidentified"} · ${step.reasoningEffort ?? "unspecified"}`;
    const existing = allocationMap.get(key) ?? {
      route: step.provider === "codex-chatgpt-signin" ? "Codex" : step.provider ?? "unidentified provider",
      model: step.model ?? null, reasoningEffort: step.reasoningEffort ?? null, completedSteps: 0,
    };
    if (step.provider === "cursor-browser-login" && step.model) existing.model = step.model;
    existing.completedSteps += 1;
    allocationMap.set(key, existing);
  }
  const allocationPercentages = [...allocationMap.values()].map((entry) => ({
    ...entry,
    percentage: percent(entry.completedSteps, stepRoutingHistory.length),
  }));
  const allocationSummary = allocationPercentages.map((entry) => {
    const label = entry.route === "Codex" ? `${entry.route} ${entry.model} (${entry.reasoningEffort})` : entry.route;
    return `${label} ${entry.percentage}%`;
  }).join(", ");
  if (["completed", "stopped", "uncertain"].includes(goal.status)) {
    message = `${message} Routing allocation: ${allocationSummary}. These are percentages of completed routed steps, not code volume, time, tokens, or cash.`;
  }
  const providerNames = new Set(routingHistory.map((entry) => entry.provider));
  const providerBreakdown = [...providerNames].map((provider) => {
    const selected = routingHistory.filter((entry) => entry.provider === provider);
    const completed = selected.filter((entry) => entry.jobStatus === "completed").length;
    const failed = selected.filter((entry) => ["failed", "uncertain"].includes(entry.jobStatus)).length;
    return {
      provider,
      selectedIterations: selected.length,
      selectionPercentage: percent(selected.length, routingHistory.length),
      successfulIterations: completed,
      successfulIterationPercentage: percent(completed, routingHistory.filter((entry) => entry.jobStatus === "completed").length),
      failedOrUnappliedAttempts: failed,
    };
  });
  const codexTokenRecords = [
    ...usageRecords.map((record) => ({ inputTokens: Number(record.input_tokens ?? 0), cachedInputTokens: Number(record.cached_input_tokens ?? 0) })),
    ...providerRecords.filter((record) => record.provider === "codex" && record.tokenUsageAvailable === true),
  ];
  const codexInputTokens = codexTokenRecords.reduce((sum, record) => sum + Number(record.inputTokens ?? 0), 0);
  const codexCachedInputTokens = codexTokenRecords.reduce((sum, record) => sum + Number(record.cachedInputTokens ?? 0), 0);
  const successfulIterations = routingHistory.filter((entry) => entry.jobStatus === "completed").length;
  const failedOrUnappliedAttempts = routingHistory.filter((entry) => ["failed", "uncertain"].includes(entry.jobStatus)).length;
  const view = {
    workId: goal.id,
    task: goal.objective,
    doneWhen: goal.success_criteria,
    state,
    done: goal.status === "completed",
    message,
    verifiedProgress: goal.last_summary,
    whatRemains: goal.status === "completed" ? null : (currentJob?.iteration_objective ?? goal.next_objective ?? goal.objective),
    needsFromYou,
    routing,
    routingHistory,
    stepRoutingHistory,
    economics: {
      routeSelections: routingHistory.length,
      successfulIterations,
      failedOrUnappliedAttempts,
      activeOrQueuedIterations: routingHistory.length - successfulIterations - failedOrUnappliedAttempts,
      providerBreakdown,
      stepProviderBreakdown,
      allocationPercentages,
      routedSteps: stepRoutingHistory.length,
      codexTokenUsage: {
        inputTokens: codexInputTokens,
        cachedInputTokens: codexCachedInputTokens,
        cachedInputPercentage: percent(codexCachedInputTokens, codexInputTokens),
      },
      ordinarySoftwareIterations: routingHistory.filter((entry) => entry.provider === "software").length,
      ordinarySoftwareSteps: stepRoutingHistory.filter((entry) => entry.provider === "software").length,
      ordinarySoftwareRecoveries: jobs.reduce((count, job) => count + coordinator.events(String(job.id)).filter((event) => event.kind === "ordinary_software_recovery").length, 0),
      cashSavings: null,
      cashSavingsMeasurable: false,
      interpretation: "Step percentages count completed routed steps (inspection, execution, and verification), not code volume or human-equivalent work. Older iteration percentages remain for historical compatibility. Subscription usage has no provider charge receipt here, so cash savings cannot be claimed from these records.",
    },
    usage: {
      estimatedCreditsUsed: estimatedSpent,
      actualProviderCredits: actualSpent,
      actualProviderCreditsAvailable: actualSpent !== null,
      providerRecords,
    },
  };
  const goalGitMilestones = coordinator.goalEvents(goalId)
    .filter((event) => event.kind === "milestone_git_automation")
    .map((event) => {
      try { return JSON.parse(String(event.detail)); }
      catch { return null; }
    }).filter(Boolean);
  const jobGitMilestones = jobs.flatMap((job) => coordinator.events(String(job.id))
    .filter((event) => event.kind === "milestone_git_automation")
    .map((event) => structuredAuditDetail(event)).filter(Boolean));
  const latestGit = goalGitMilestones.at(-1) ?? jobGitMilestones.at(-1) ?? null;
  view.gitMilestone = latestGit ? {
    status: latestGit.status,
    commitMessage: latestGit.commitMessage ?? null,
    commit: latestGit.commit ?? null,
    branch: latestGit.branch ?? null,
    remote: latestGit.remote ?? null,
    pushOutcome: latestGit.pushOutcome ?? null,
    brief: latestGit.brief ?? formatMilestoneGitOwnerSummary(latestGit),
  } : null;
  return includeTechnical ? { ...view, technicalDetails: { goal, currentJob, events: coordinator.goalEvents(goalId) } } : view;
}

function progressView(coordinator, goalId, paths, includeTechnical = false) {
  const view = ownerWorkView(coordinator, goalId, includeTechnical);
  const goal = coordinator.getGoal(goalId);
  const currentJob = goal.current_job_id ? coordinator.getJob(String(goal.current_job_id)) : null;
  const active = activeRunForGoal(paths.database, goalId);
  let stage = "Validation";
  if (view.done) stage = "Complete";
  else if (currentJob?.status === "queued") stage = active?.alive === true ? "Packaging" : "Queued";
  let maximumIdleSeconds = 0;
  try {
    const workerConfig = JSON.parse(readFileSync(paths.workerConfig, "utf8"));
    maximumIdleSeconds = Number(workerConfig.maximumIdleSeconds ?? workerConfig.idleProgressTimeoutSeconds ?? 0);
  } catch { /* Setup diagnostics own missing or invalid configuration. */ }
  const checkpoint = progressCheckpoint(coordinator.goalEvents(goalId), currentJob, maximumIdleSeconds);
  const stallWarning = checkpoint.possiblyStalled
    ? `The worker is still renewing its lease, but it has produced no durable work checkpoint for ${checkpoint.noProgressSeconds} seconds. Treat this as a possible stall, not as progress; the idle watchdog should stop and recover the iteration.`
    : null;
  const stateLabel = view.done ? "Complete" : checkpoint.possiblyStalled ? "Possibly stalled"
    : view.state === "working" || view.state === "continuing" ? "Working"
    : view.state === "waiting_on_origin_host" ? "Origin-host action"
    : view.state === "ready_to_start" || view.state === "queued" ? "Queued"
    : view.state === "paused" ? "Paused" : view.state === "needs_your_decision" ? "Needs your action" : "Attention needed";
  const route = view.routing
    ? [view.routing.provider === "software" ? "ordinary software" : view.routing.provider, view.routing.model, view.routing.reasoningEffort].filter(Boolean).join(" · ")
    : null;
  const warning = stallWarning ?? (["stopped_by_problem", "checking_what_happened"].includes(view.state) ? view.message : null);
  if (stallWarning && view.state === "working") view.message = stallWarning;
  return { ...view, goalId, stage, stateLabel, route, remaining: view.whatRemains,
    lastActivity: String(checkpoint.lastProgressAt ?? goal.updated_at ?? goal.created_at), ...checkpoint, warning };
}

function progressCursor(coordinator, goalId) {
  const events = coordinator.goalEvents(goalId);
  return events.length ? Number(events.at(-1).sequence) : 0;
}

function auditCheck(name, status, summary, evidence = undefined) {
  return { name, status, summary, ...(evidence === undefined ? {} : { evidence }) };
}

export function gitMilestoneCheckStatus(result) {
  if (!result) return "not_exercised";
  if (result.status === "committed_and_pushed") return "pass";
  if (result.status === "committed_not_pushed") return "partial";
  if (result.status === "skipped") {
    return /no Git changes|no staged changes|no verified milestone paths/i.test(String(result.reason ?? ""))
      ? "partial" : "fail";
  }
  return "fail";
}

export function formatMilestoneGitOwnerSummary(result) {
  if (!result) return "No verified milestone Git action was recorded for this goal.";
  const brief = result.brief || [
    `status=${result.status}`,
    `commitMessage=${result.commitMessage ?? "(none)"}`,
    `sha=${result.commit ?? "(none)"}`,
    `branch=${result.branch ?? "(none)"}`,
    `remote=${result.remote ?? "(none)"}`,
    `push=${result.pushOutcome ?? "not_attempted"}`,
    `detail=${result.reason ?? ""}`,
  ].join("; ");
  return `Latest verified milestone Git action: ${brief}`;
}

export function recordedHostVerificationCommands(events) {
  return events.flatMap(({event, detail}) => {
    if (event.kind !== 'ordinary_software_external_verification' || !detail) return [];
    let note=detail;
    if (typeof detail.detail === 'string') { try { note=JSON.parse(detail.detail); } catch { return []; } }
    if (note.modelInvoked !== false || !Array.isArray(note.checks)) return [];
    return note.checks.filter(check => check.passed === true && check.exitCode === 0 && typeof check.command === 'string').map(check => check.command);
  });
}

export function comparableCacheShare(input, cached, externalRecords) {
  // Provider records can exclude cached input; Codex input includes it.
  // Preserve raw totals and avoid a false mixed-convention percentage.
  if (externalRecords.length) return null;
  return input ? Math.round((cached / input) * 1000) / 10 : 0;
}

export function ownerFacingCompletionReport(audit) {
  const gitMilestone = audit.checks.find((check) => check.name === "git_milestone");
  const finished = audit.productResult === "complete";
  const needsRepair = audit.coordinatorVerdict === "repair_needed";
  const ownerBrief = {
    headline: finished ? "The requested task is finished." : "The requested task is not finished yet.",
    whatWasDone: audit.verifiedProgress || audit.summary,
    whatThisMeans: finished
      ? "You can treat this task as complete. This does not mean the whole project is finished unless that was the task."
      : needsRepair
        ? "The work is preserved, but the coordinator found a reporting or verification problem that must be repaired before this task can be called complete."
        : "The work is preserved and can continue from its recorded stopping point.",
    whatIsStillOutstanding: finished ? "Nothing remains for this task." : (audit.whatRemains || "The task still has unfinished work."),
    whatYouNeedToDo: audit.needsFromYou || "Nothing is needed from you right now.",
    referenceNote: "Tracker codes, gate names, hashes, routes and ledger IDs are optional technical references. Do not use them as the explanation. If one is useful, pair it with a plain-English description and say which project document it comes from.",
  };
  return {
    title: "Amadeus task-end report",
    ownerBrief,
    productResult: audit.productResult,
    coordinatorVerdict: audit.coordinatorVerdict,
    summary: audit.summary,
    workAllocation: audit.workAllocation,
    verification: audit.checks.map(({ name, status, summary }) => ({ name, status, summary })),
    usage: audit.usage,
    completionScope: audit.completionScope,
    gitMilestone: gitMilestone ? {
      status: gitMilestone.status,
      summary: gitMilestone.summary,
      evidence: gitMilestone.evidence,
    } : null,
  };
}

async function completionAudit(goalId, paths) {
  const snapshot = withCoordinator(paths.database, (coordinator) => {
    const goal = coordinator.getGoal(goalId);
    const jobs = coordinator.status().jobs.filter((job) => job.goal_id === goalId);
    return {
      goal,
      goalEvents: coordinator.goalEvents(goalId),
      jobs: jobs.map((job) => ({
        ...job,
        events: coordinator.events(String(job.id)),
        usage: coordinator.usage(String(job.id)),
        patchReceipts: coordinator.patchReceipts(String(job.id)).records,
      })),
    };
  });
  const checks = [];
  const allEvents = snapshot.jobs.flatMap((job) => job.events.map((event) => ({ job, event, detail: structuredAuditDetail(event) })));
  const routeSelections = allEvents.filter(({ event }) => event.kind === "route_selected" && structuredAuditDetail(event));
  const started = allEvents.filter(({ event, detail }) => event.kind === "route_step_started" && detail?.step);
  const completed = allEvents.filter(({ event, detail }) => event.kind === "route_step_completed" && detail?.step);
  const completionKeys = new Set(completed.map(({ job, detail }) => `${job.id}:${detail.step}`));
  const unmatched = started.filter(({ job, detail }) => !completionKeys.has(`${job.id}:${detail.step}`));
  checks.push(auditCheck("product_outcome", snapshot.goal.status === "completed" ? "pass" : "fail",
    snapshot.goal.status === "completed" ? "The product task is recorded complete with durable evidence." : `The product task ended as ${snapshot.goal.status}, not complete.`,
    { lastSummary: snapshot.goal.last_summary ?? null }));
  checks.push(auditCheck("step_accounting", unmatched.length ? "fail" : "pass",
    unmatched.length ? `${unmatched.length} routed step(s) started without a matching completion record.` : "Every recorded routed step has a terminal result.",
    unmatched.map(({ job, detail }) => ({ jobId: job.id, step: detail.step }))));

  const selections = routeSelections.map(({ job, event }) => ({ job, selected: structuredAuditDetail(event), at: event.created_at }))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const pinned = selections.filter(({ selected }) => /preserved explicit|pinned/i.test(String(selected.reason ?? "")));
  const providers = [...new Set(selections.map(({ selected }) => selected.provider).filter(Boolean))];
  checks.push(auditCheck("automatic_routing", selections.length === 0 ? "fail" : pinned.length === selections.length ? "not_exercised" : "pass",
    selections.length === 0 ? "No durable route selection was recorded."
      : pinned.length === selections.length ? "Every model route was explicitly pinned, so automatic model/tool choice was not tested."
        : "At least one route was selected automatically from task suitability.",
    { selections: selections.length, pinned: pinned.length, providers }));
  const balancedSelections = selections.filter(({ selected }) => selected.routingPolicy === "balanced-quality");
  const unjustifiedStrongRoutes = balancedSelections.filter(({ selected }) =>
    ["workhorse", "frontier"].includes(String(selected.capabilityTier))
      && (!Array.isArray(selected.capabilitySignals) || selected.capabilitySignals.length === 0));
  const inflatedRoutineRoutes = balancedSelections.filter(({ selected }) =>
    selected.taskClass === "routine-implementation"
      && ["workhorse", "frontier"].includes(String(selected.capabilityTier)));
  const costRoutingProblems = [...unjustifiedStrongRoutes, ...inflatedRoutineRoutes]
    .map(({ job, selected }) => ({ jobId: job.id, taskClass: selected.taskClass,
      capabilityTier: selected.capabilityTier, reason: selected.reason ?? null }));
  checks.push(auditCheck("cost_routing_justification", balancedSelections.length === 0 ? "not_exercised"
    : costRoutingProblems.length ? "fail" : "pass",
  balancedSelections.length === 0 ? "This goal predates the balanced-quality routing evidence contract."
    : costRoutingProblems.length ? "A stronger Codex route lacked capability evidence or was used for routine implementation."
      : "Every exercised balanced-quality route used the lowest recorded capability tier or supplied evidence for a stronger route.",
  costRoutingProblems));
  checks.push(auditCheck("cursor_routing", providers.includes("cursor-browser-login") ? "pass" : "not_exercised",
    providers.includes("cursor-browser-login") ? "Cursor was selected for at least one routed iteration." : "Cursor was not selected in this task, so that route remains unproven here."));

  const repeated = [];
  for (let index = 0; index < selections.length; index += 1) {
    const current = selections[index];
    if (!["failed", "uncertain"].includes(String(current.job.status))) continue;
    // An explicitly pinned route is an owner-selected constraint. Reusing that
    // route after a corrected, in-scope retry is intentional and must not be
    // reported as duplicate model spend. Automatic/provider-fallback routes
    // remain subject to the alternate-provider rule.
    if (pinned.includes(current)) continue;
    const hadSpend = Number(current.job.attempt_count ?? 0) > 0 && (current.job.usage.records.length || current.job.usage.providerRecords.length);
    const later = selections.slice(index + 1).find(({ selected }) => selected.provider === current.selected.provider
      && (selected.model ?? null) === (current.selected.model ?? null)
      && !pinned.includes(selected));
    const providerAttemptFailed = providerExecutionFailed(current.job);
    if (providerAttemptFailed && hadSpend && later) repeated.push({ failedJobId: current.job.id, replacementJobId: later.job.id,
      provider: current.selected.provider, model: current.selected.model ?? null });
  }
  checks.push(auditCheck("repeat_model_spend", repeated.length ? "fail" : "pass",
    repeated.length ? `${repeated.length} failed or uncertain subscription attempt(s) were followed by the same model/provider route.` : "No repeated same-route model spend was detected after a failed or uncertain attempt.", repeated));

  const verifyEvents = completed.filter(({ detail }) => detail.step === "verify");
  const verifyCommands = [...verifyEvents.flatMap(({ detail }) => Array.isArray(detail.checks) ? detail.checks.map((item) => item.command).filter(Boolean) : []), ...recordedHostVerificationCommands(allEvents)];
  const functionalChecks = verifyCommands.filter((command) => command !== "git diff --check");
  checks.push(auditCheck("verification_depth", verifyCommands.length === 0 ? "not_exercised" : functionalChecks.length ? "pass" : "partial",
    verifyCommands.length === 0 ? "No independent verification result was recorded."
      : functionalChecks.length ? "Independent product checks ran in addition to patch-integrity checking."
        : "Verification covered patch integrity only; no declared product test was recorded.",
    { commands: [...new Set(verifyCommands)] }));

  const receipts = snapshot.jobs.flatMap((job) => job.patchReceipts.map((receipt) => ({ job, receipt })));
  const applied = receipts.filter(({ receipt }) => Number(receipt.applied) === 1);
  const malformedApplied = applied.filter(({ receipt }) => !receipt.checkpoint_receipt || !receipt.patch_sha256);
  checks.push(auditCheck("checkpoint_and_apply", receipts.length === 0 ? "not_exercised" : malformedApplied.length ? "fail" : "pass",
    receipts.length === 0 ? "This task recorded no patch receipt."
      : malformedApplied.length ? "An applied patch is missing its checkpoint or hash evidence."
        : `${applied.length} applied patch(es) have checkpoint and hash evidence; ${receipts.length - applied.length} capture-only patch(es) were not applied.`));

  const receiptResults = [];
  for (const { job, selected } of selections) {
    if (selected.provider !== "codex-chatgpt-signin" || Number(job.attempt_count ?? 0) <= 0) continue;
    const externalDisposition = externallyVerifiedReceiptDisposition(job, snapshot.goalEvents);
    if (externalDisposition) {
      receiptResults.push(externalDisposition);
      continue;
    }
    const requiresVerifiedReceipt = String(job.status) === "completed";
    try {
      const receipt = await verifyJobReceipt(String(job.id), paths, true, true);
      receiptResults.push({ jobId: job.id, status: job.status, verified: true,
        requiredForCompletedResult: requiresVerifiedReceipt, sourceManifestStillMatches: receipt.sourceManifestStillMatches,
        sourceManifestDisposition: receipt.sourceManifestStillMatches === false
          ? "advisory_source_manifest_drift"
          : receipt.sourceManifestStillMatches === true ? "source_manifest_matches"
            : "historical_workspace_unavailable_nonblocking_for_receipt_audit",
        workspaceAvailable: receipt.workspaceAvailable,
        workspaceDisposition: receipt.workspaceDisposition });
    } catch (error) {
      receiptResults.push({ jobId: job.id, status: job.status,
        verified: requiresVerifiedReceipt ? false : null,
        requiredForCompletedResult: requiresVerifiedReceipt,
        expectedIncompleteAttempt: !requiresVerifiedReceipt,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  const receiptFailures = receiptResults.filter((item) => item.requiredForCompletedResult && item.verified !== true);
  checks.push(auditCheck("receipt_integrity", receiptResults.length === 0 ? "not_exercised"
    : receiptFailures.length ? "fail" : "pass",
  receiptResults.length === 0 ? "No Codex result receipt was available for re-verification."
    : receiptFailures.length ? "At least one completed Codex result failed read-only receipt verification."
      : receiptResults.some((item) => item.expectedIncompleteAttempt)
        ? "Completed Codex receipts passed; incomplete failed or timed-out attempts remain preserved but are not treated as successful receipts."
        : "Saved Codex result receipts passed read-only verification with expected worker changes allowed.", receiptResults));

  const jobGitMilestones = allEvents.filter(({ event }) => event.kind === "milestone_git_automation" && structuredAuditDetail(event))
    .map(({ job, event }) => ({ jobId: job.id, ...structuredAuditDetail(event) }));
  const goalGitMilestones = snapshot.goalEvents.filter((event) => event.kind === "milestone_git_automation")
    .map((event) => {
      try { return JSON.parse(String(event.detail)); }
      catch { return null; }
    }).filter(Boolean);
  const gitMilestones = goalGitMilestones.length ? goalGitMilestones : jobGitMilestones;
  const latestGitMilestone = gitMilestones.at(-1);
  checks.push(auditCheck("git_milestone", gitMilestoneCheckStatus(latestGitMilestone),
    formatMilestoneGitOwnerSummary(latestGitMilestone), gitMilestones));

  let operations;
  try { operations = await jsonFile(paths.operations); } catch { operations = null; }
  const limits = operations?.admissionLimits;
  const unwantedRestrictions = limits ? Object.entries(limits).filter(([key, value]) => key !== "financialAdmissionEnforced" && value !== null) : [];
  const restrictionOk = limits?.financialAdmissionEnforced === false && unwantedRestrictions.length === 0;
  checks.push(auditCheck("temporary_restrictions", operations === null ? "fail" : restrictionOk ? "pass" : "fail",
    operations === null ? "The coordinator operations policy could not be read."
      : restrictionOk ? "No unrequested financial, timeout, file-count, or line-count admission ceiling is active."
        : "One or more temporary admission restrictions are active.", unwantedRestrictions));

  const usageRecords = snapshot.jobs.flatMap((job) => job.usage.records);
  const providerRecords = snapshot.jobs.flatMap((job) => job.usage.providerRecords ?? []);
  const inputTokens = usageRecords.reduce((sum, row) => sum + Number(row.input_tokens ?? 0), 0)
    + providerRecords.reduce((sum, row) => sum + Number(row.inputTokens ?? 0), 0);
  const cachedInputTokens = usageRecords.reduce((sum, row) => sum + Number(row.cached_input_tokens ?? 0), 0)
    + providerRecords.reduce((sum, row) => sum + Number(row.cachedInputTokens ?? 0), 0);
  const outputTokens = usageRecords.reduce((sum, row) => sum + Number(row.output_tokens ?? 0), 0)
    + providerRecords.reduce((sum, row) => sum + Number(row.outputTokens ?? 0), 0);
  const allocationKeys = new Map([
    ["ordinary-software", { route: "ordinary software", model: null, costBasis: "local-no-model", completedSteps: 0 }],
    ["cursor", { route: "Cursor", model: null, costBasis: "subscription-allowance", completedSteps: 0 }],
  ]);
  for (const { detail } of completed) {
    const key = detail.provider === "software" ? "ordinary-software"
      : detail.provider === "cursor-browser-login" ? "cursor"
        : `${detail.provider ?? "unidentified provider"}:${detail.model ?? "unidentified"}:${detail.reasoningEffort ?? "unspecified"}`;
    if (!allocationKeys.has(key)) allocationKeys.set(key, {
      route: detail.provider === "codex-chatgpt-signin" ? "Codex" : detail.provider ?? "unidentified provider",
      model: detail.model ?? null, reasoningEffort: detail.reasoningEffort ?? null,
      costBasis: "subscription-allowance", completedSteps: 0,
    });
    if (detail.provider === "cursor-browser-login" && detail.model) allocationKeys.get(key).model = detail.model;
    allocationKeys.get(key).completedSteps += 1;
  }
  const allocationPercentages = [...allocationKeys.values()].map((entry) => ({
    ...entry,
    percentage: completed.length ? Math.round((entry.completedSteps / completed.length) * 1000) / 10 : 0,
  }));
  const failures = checks.filter((check) => check.status === "fail");
  const gaps = checks.filter((check) => ["partial", "not_exercised"].includes(check.status));
  const audit = {
    auditVersion: 1,
    temporary: false,
    reportingOnly: true,
    goalId,
    productResult: snapshot.goal.status === "completed" ? "complete" : "incomplete",
    coordinatorVerdict: failures.length ? "repair_needed" : gaps.length ? "partially_proven" : "working_as_intended",
    repairNeeded: failures.length > 0,
    checks,
    routing: { selections: selections.length, providers, completedSteps: completed.length, unmatchedStartedSteps: unmatched.length },
    workAllocation: {
      basis: "completed-routed-steps",
      disclaimer: "These percentages show routing activity, not code volume, time, token cost, or cash savings. Ordinary software is local/no-model; Codex and Cursor use subscription allowance unless an actual provider charge receipt says otherwise.",
      allocationPercentages,
      actualChargePercentages: null,
    },
    completionScope: { completedEntity: "coordinator-goal", wholeProjectCompletionInferred: false },
    usage: { inputTokens, cachedInputTokens, outputTokens,
      cachedInputPercentage: comparableCacheShare(inputTokens, cachedInputTokens, providerRecords),
      cachePercentageBasis: providerRecords.length ? "Unavailable across provider cache conventions; raw totals preserved" : "Codex input includes cache",
      actualCashSavings: null, cashSavingsMeasurable: false },
    summary: failures.length
      ? `Product ${snapshot.goal.status === "completed" ? "finished" : "did not finish"}; the coordinator audit found ${failures.length} defect(s) needing repair.`
      : gaps.length ? `Product ${snapshot.goal.status === "completed" ? "finished" : "did not finish"}; no coordinator defect was proven, but ${gaps.length} route or verification area(s) remain only partially tested.`
        : "Product finished and all exercised coordinator checks passed.",
    verifiedProgress: snapshot.goal.last_summary ?? null,
    whatRemains: snapshot.goal.status === "completed" ? null : (snapshot.goal.next_objective ?? snapshot.goal.objective ?? null),
    needsFromYou: ["waiting_approval", "blocked"].includes(String(snapshot.goal.status))
      ? (snapshot.goal.question ?? null) : null,
  };
  audit.ownerReport = ownerFacingCompletionReport(audit);
  return audit;
}

const MEANINGFUL_PROGRESS_EVENT_KINDS = new Set([
  "iteration_started", "step_started", "step_completed", "iteration_completed",
  // Orchestrator emits the route-prefixed forms. Keep both spellings so
  // progress is not silently lost between the worker ledger and the chat.
  "route_step_started", "route_step_completed", "route_selected",
  "worker_progress",
  "iteration_recovered", "iteration_completed_external_verification", "reconciled",
  "retry_stage_corrected", "retry_authorized", "retry_queued_paused",
  "technical_recovery_queued", "answered", "stopped", "completion_invalidated",
  "uncertain", "blocked", "stalled_recovery_requested", "milestone_git_automation",
  "usage_limit_paused", "usage_limit_resumed", "progress_limit_reached",
]);

export function isMeaningfulProgressEvent(event) {
  return MEANINGFUL_PROGRESS_EVENT_KINDS.has(String(typeof event === "string" ? event : event?.kind));
}

function describeProgressEvent(event) {
  const detail = structuredAuditDetail(event) ?? goalEventDetail(event) ?? {};
  if (typeof detail.summary === "string" && detail.summary.trim()) return detail.summary.trim();
  if (event.kind === "route_selected") {
    return `Selected ${[detail.provider, detail.model, detail.reasoningEffort].filter(Boolean).join(" · ")} for the next bounded step.`;
  }
  if (event.kind === "route_step_started") return `Started the ${detail.step ?? "next"} step.`;
  if (event.kind === "route_step_completed") return `Completed the ${detail.step ?? "current"} step${detail.passed === false ? " with a failure to recover" : ""}.`;
  if (event.kind === "worker_progress") return "The worker recorded a new implementation checkpoint.";
  if (event.kind === "usage_limit_paused") return `The AI provider's usage limit was reached; work is saved and resumes after ${detail.resumeAt ?? "the reset"}.`;
  if (event.kind === "usage_limit_resumed") return "The provider usage window reset; resuming the saved step.";
  const ownerDetail = goalEventDetail(event);
  if (typeof ownerDetail?.summary === "string" && ownerDetail.summary.trim()) return ownerDetail.summary.trim();
  return String(event.kind).replaceAll("_", " ");
}

export function progressCheckpoint(events, currentJob, maximumIdleSeconds, now = Date.now()) {
  const jobId = currentJob?.id === undefined || currentJob?.id === null ? null : String(currentJob.id);
  const relevant = events.filter((event) => {
    if (!isMeaningfulProgressEvent(event)) return false;
    const detail = goalEventDetail(event);
    if (!jobId) return true;
    if (detail?.jobId) return String(detail.jobId) === jobId;
    // Untagged legacy events count only when they belong to this job's lifetime.
    return !!currentJob?.created_at && Date.parse(event.created_at) >= Date.parse(currentJob.created_at);
  });
  const latest = relevant.at(-1) ?? null;
  const latestHeartbeat = [...events].reverse().find((event) => event.kind === "heartbeat"
    && (!jobId || String(goalEventDetail(event)?.jobId ?? "") === jobId)) ?? null;
  const lastProgressAt = latest?.created_at ?? currentJob?.started_at ?? currentJob?.created_at ?? null;
  const livenessAt = currentJob?.heartbeat_at ?? latestHeartbeat?.created_at ?? null;
  const ageSeconds = lastProgressAt ? Math.max(0, Math.floor((now - Date.parse(lastProgressAt)) / 1000)) : null;
  const idleSeconds = Number(maximumIdleSeconds) || 0;
  const possiblyStalled = currentJob?.status === "running" && idleSeconds > 0
    && ageSeconds !== null && ageSeconds >= idleSeconds;
  return {
    currentAction: latest ? describeProgressEvent(latest) : "Preparing the first durable work checkpoint.",
    lastProgressAt,
    livenessAt,
    noProgressSeconds: ageSeconds,
    possiblyStalled,
  };
}

export function liveProgressSummary(snapshot) {
  const economics = snapshot?.economics ?? {};
  const allocation = Array.isArray(economics.allocationPercentages)
    ? economics.allocationPercentages.map((entry) => ({
      route: entry.route,
      model: entry.model ?? null,
      reasoningEffort: entry.reasoningEffort ?? null,
      percentage: entry.percentage,
      completedSteps: entry.completedSteps,
    }))
    : [];
  return {
    productResult: snapshot?.done ? "complete" : "in_progress",
    stage: snapshot?.stage ?? null,
    state: snapshot?.stateLabel ?? snapshot?.state ?? null,
    route: snapshot?.route ?? null,
    lastActivity: snapshot?.lastActivity ?? null,
    lastProgressAt: snapshot?.lastProgressAt ?? snapshot?.lastActivity ?? null,
    livenessAt: snapshot?.livenessAt ?? null,
    currentAction: snapshot?.currentAction ?? null,
    noProgressSeconds: snapshot?.noProgressSeconds ?? null,
    possiblyStalled: snapshot?.possiblyStalled === true,
    remaining: snapshot?.remaining ?? snapshot?.whatRemains ?? null,
    workAllocation: {
      basis: "completed-routed-steps",
      percentages: allocation,
      disclaimer: "Percentages are routing activity, not code volume, time, token cost, or cash savings.",
    },
  };
}

export function withBackgroundHostState(snapshot, active) {
  if (active?.goalId === snapshot?.goalId && active.alive === false) {
    return {
      ...snapshot,
      state: "checking_what_happened",
      stateLabel: "Attention needed",
      warning: "The background host stopped unexpectedly. Work is not verified finished; saved results and remaining processes need checking before continuation.",
      message: "The background host stopped unexpectedly. Work is not verified finished; saved results and remaining processes need checking before continuation.",
      done: false,
    };
  }
  return snapshot;
}

async function waitForWorkUpdate(goalId, afterCursor, timeoutSeconds, paths) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let snapshot;
  let cursor = afterCursor;
  do {
    // An unattended goal paused by a provider usage limit restarts itself once the window resets.
    if (withCoordinator(paths.database, (coordinator) => coordinator.resumeAfterUsageLimit(goalId))) {
      await callTool("start_work", { goalId }, paths);
    }
    const result = withCoordinator(paths.database, (coordinator) => {
      const next = progressView(coordinator, goalId, paths);
      const events = coordinator.goalEvents(goalId);
      const latest = events.length ? Number(events.at(-1).sequence) : 0;
      return {
        snapshot: next,
        cursor: latest,
        events: events.filter((event) => Number(event.sequence) > afterCursor
          && isMeaningfulProgressEvent(event)),
      };
    });
    snapshot = withBackgroundHostState(result.snapshot, activeRunForGoal(paths.database, goalId));
    cursor = result.cursor;
    const originHostHandoff = snapshot.state === "waiting_on_origin_host";
    const terminal = snapshot.done || originHostHandoff || ["stopped_by_problem", "checking_what_happened", "needs_your_decision", "paused"].includes(snapshot.state);
    if (result.events.length > 0 || terminal) {
      const audit = terminal ? await completionAudit(goalId, paths) : undefined;
      return { ...snapshot, changed: result.events.length > 0, progressCursor: cursor, progressEvents: result.events,
        liveProgress: liveProgressSummary(snapshot),
        ...(audit ? { completionAudit: audit } : {}),
        ...(originHostHandoff ? { nextAction: "execute_origin_host_handoff_and_continue", keepOriginatingTurnOpen: true, doNotFinalize: true } : {}) };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(750, deadline - Date.now())));
  } while (Date.now() < deadline);
  const originHostHandoff = snapshot?.state === "waiting_on_origin_host";
  const stillActive = snapshot?.state === "working" || snapshot?.state === "continuing" || snapshot?.state === "running"
    || snapshot?.state === "waiting_for_usage_reset";
  return { ...snapshot, changed: false, progressCursor: cursor, progressEvents: [],
    liveProgress: liveProgressSummary(snapshot),
    keepOriginatingTurnOpen: stillActive || originHostHandoff,
    nextAction: originHostHandoff ? "execute_origin_host_handoff_and_continue" : stillActive ? "wait_for_work_update" : undefined,
    doNotFinalize: stillActive || originHostHandoff,
    message: originHostHandoff
      ? "A saved host-side step is ready. Execute it from this originating turn, then record evidence and continue; do not enqueue another model worker."
      : stillActive
      ? snapshot?.possiblyStalled
        ? `${snapshot.message} Last concrete checkpoint: ${snapshot.currentAction}`
        : `No new work checkpoint arrived in this wait. Current action: ${snapshot?.currentAction ?? "continuing the bounded step"}. The worker last proved liveness at ${snapshot?.livenessAt ?? "an unknown time"}.`
      : (snapshot?.message ?? "No meaningful stage change was recorded during this wait.") };
}

function toolDefinitions() {
  const goalId = { type: "string", description: "Coordinator goal UUID." };
  const projectOptions = {
    projectRoot: { type: "string", description: "Absolute folder of the project selected by the user/current chat. Required for new ordinary development; never assume a default private project." },
    provider: { type: "string", enum: ["codex-chatgpt-signin", "cursor-browser-login"] },
    model: { type: "string", description: "Available subscription model; no artificial Luna-only restriction." },
    reasoningEffort: { type: "string" },
    pinRoute: { type: "boolean", default: false, description: "Set true only when the owner explicitly requested this provider/model route. Omit it for automatic routing." },
  };
  return [
    ...onboardingToolDefinitions(),
    ...["preview", "run", "view", "delete"].map(action => ({
      name: "amadeus_discovery_" + action,
      description: ({ preview: "Preview optional inventory sources without collection.", run: "Run only on a separate explicit user scan request and current scoped consent.", view: "Read locally saved capability results.", delete: "Delete locally saved discovery results." })[action],
      annotations: { readOnlyHint: ["preview", "view"].includes(action) },
      inputSchema: { type: "object", additionalProperties: false, properties: {
        ...(action === "preview" || action === "run" ? { categories: { type: "array", items: { enum: ["hardware", "development-tools", "local-providers"] } }, locations: { type: "array", items: { type: "string" }, maxItems: 20 } } : {}),
        ...(action === "run" ? { requested: { type: "boolean", const: true } } : {}),
      }, ...(action === "run" ? { required: ["requested"] } : {}) },
    })),
    { name: "work_status", description: "Show project work in plain language: what is finished, what remains, whether anything needs the owner, and recorded usage. Technical coordinator details are hidden unless explicitly requested.", inputSchema: { type: "object", additionalProperties: false, properties: { goalId, includeTechnical: { type: "boolean", default: false } } } },
    { name: "completion_audit", description: "Generate the durable task-end report and diagnostic audit. Terminal work_status and wait_for_work_update results include this report automatically; include ownerReport in the user-facing task-end report. Separately reports product completion, routing/accounting integrity, duplicate model spend, verification depth, receipt integrity, and whether coordinator repair is needed.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    { name: "wait_for_work_update", description: "Keep the current Codex turn active while local coordinator work advances. Returns on the next concrete work checkpoint or after a short timeout; lease heartbeats are liveness only and never count as progress. Active results identify the current action, last meaningful checkpoint, liveness time, and possible-stall state. Terminal results include the generated ownerReport and diagnostic audit; include that report in the user-facing task-end report. If the result says keepOriginatingTurnOpen=true or doNotFinalize=true, the goal is still active: immediately call this tool again with the returned progressCursor and do not send a final response.",
      inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "afterCursor"], properties: {
        goalId,
        afterCursor: { type: "integer", minimum: 0, description: "The progressCursor returned by start_work, work_status, or the previous wait." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 45, default: 45 },
      } },
      _meta: { "openai/toolInvocation/invoking": "Waiting for work to advance…", "openai/toolInvocation/invoked": "Progress checked." } },
    {
      name: "delegate_work",
      description: "Prepare durable work for any selected project. Use start_work immediately when the user requested execution; no separate spending approval is needed.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["task", "doneWhen", "boundaries"],
        properties: {
          ...projectOptions,
          task: { type: "string", minLength: 1 },
          doneWhen: { type: "string", minLength: 1 },
          boundaries: { type: "string", minLength: 1 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 160 },
          executionProfile: { type: "string", enum: ["approved-public-project"], default: "approved-public-project" }
        }
      }
    },
    { name: "start_work", description: "Run authorized work independently of the chat until finished or genuinely blocked. Keep the originating assistant turn open and immediately call wait_for_work_update with the returned progressCursor; do not end the turn after launch. Ordinary development defaults to project-wide writes, not read-only.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId, writableWorkspacePaths: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 } } } } },
    { name: "status", description: "Read coordinator health, limits, jobs, goals, and outstanding estimated reservations. This never starts work.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    {
      name: "amadeus_lifecycle_status",
      description: "Show consent-gated update status, provider-discovery consent, registry summary, and stable-channel local-model pilot gate (disabled until friend-machine pilot).",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "amadeus_update_consent",
      description: "Grant or decline consent for update checks against MadMaxSoftware/amadeus only. No silent activation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["consent"],
        properties: { consent: { type: "boolean", description: "true grants update-check consent; false declines" } },
      },
    },
    {
      name: "amadeus_check_updates",
      description: "Check MadMaxSoftware/amadeus for newer releases when consent is granted (startup/24h policy). Never hot-replaces; activation needs separate approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { force: { type: "boolean", default: false } },
      },
    },
    {
      name: "amadeus_provider_discovery_consent",
      description: "Record an explicit choice for optional hardware, relevant software and local-provider inventory after showing the current disclosure. Known dependency checks are separate. Does not start discovery.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["consent"],
        properties: { consent: { type: "boolean" }, scopes: { type: "array", items: { enum: ["hardware", "development-tools", "local-providers"] } }, disclosureVersion: { type: "integer", description: "Required when granting; use the version displayed by amadeus_onboarding_status." } },
      },
    },
    {
      name: "amadeus_discover_providers",
      description: "Alias of amadeus_discovery_run for the local-providers category only. Same consented discovery path; detection grants no routing authority.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ['requested'],
        properties: {
          requested: { type: 'boolean', const: true, description: 'A separate explicit user scan request is required.' },
          locations: { type: "array", items: { type: "string" }, maxItems: 20 },
        },
      },
    },
    {
      name: "amadeus_approve_provider",
      description: "Explicitly approve or revoke approval for one discovered provider. Separate from enable and from routing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["providerId", "approval"],
        properties: {
          providerId: { type: "string", minLength: 1, maxLength: 200 },
          approval: { type: "boolean" },
          enable: { type: "boolean", description: "When true with approval, also enable the provider (still requires qualification before routing)." },
        },
      },
    },
    { name: "list_goals", description: "List all durable coordinator goals or inspect one goal and its current job.", inputSchema: { type: "object", additionalProperties: false, properties: { goalId } } },
    { name: "goal_events", description: "Read the durable event history for one coordinator goal.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    {
      name: "create_goal",
      description: "Prepare a persistent goal for the selected project without launching a worker.",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["objective", "successCriteria", "constraints"],
        properties: {
          ...projectOptions,
          objective: { type: "string", minLength: 1 },
          successCriteria: { type: "string", minLength: 1 },
          constraints: { type: "string", minLength: 1 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 160 },
          executionProfile: {
            type: "string",
            enum: ["approved-public-project"],
            default: "approved-public-project",
            description: "Hash-bound source profile. Only approved-public-project is supported."
          }
        }
      }
    },
    { name: "pause_goal", description: "Drain-pause an active goal. A running bounded iteration may finish, but no successor is dispatched.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    { name: "resume_goal", description: "Resume a paused goal without launching a worker. For a blocked continuous goal with a saved origin-host handoff and no worker objective, returns that handoff without queuing a rediscovery worker; execute the host step from the originating turn, then continue the same goal.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    { name: "retry_failed_goal", description: "After an explicitly acknowledged failed iteration and a verified correction, queue one paused replacement under the same unfinished goal. This never launches a worker.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "reason"], properties: { goalId, reason: { type: "string", minLength: 1 } } } },
    { name: "answer_goal", description: "Answer the durable approval question for a goal and queue its next bounded iteration without launching it.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "answer"], properties: { goalId, answer: { type: "string", minLength: 1 } } } },
    { name: "stop_goal", description: "Stop a goal. A queued job is cancelled; a running job receives the existing stop request and uncertain-outcome protections.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "reason"], properties: { goalId, reason: { type: "string", minLength: 1 } } } },
    {
      name: "verify_job_receipt",
      description: "Read and verify the fixed result artifact and isolated workspace for one dispatched job. Reports recovered usage and strict goal-receipt validity but never reconciles or launches work.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["jobId"],
        properties: { jobId: { type: "string", description: "Coordinator job UUID." } }
      }
    },
    {
      name: "reconcile_job",
      description: "Resolve one uncertain job only from externally verified evidence. Completed closes a goal only when the job's worker receipt verifies and records a complete decision (use complete_external_verification for host-verified work), failed blocks it for review, and queued makes the same job eligible again without launching it.",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["jobId", "observed", "detail"],
        properties: {
          jobId: { type: "string", description: "Coordinator job UUID." },
          observed: { type: "string", enum: ["completed", "blocked", "failed", "queued"] },
          detail: { type: "string", minLength: 1 },
          recoverVerifiedUsage: { type: "boolean", default: true, description: "Record parsed usage from the fixed completed-turn artifact when no usage record exists." }
        }
      }
    },
    {
      name: "complete_external_verification",
      description: "Close a blocked or uncertain goal after ordinary software has externally verified its preserved completed workspace. This never launches a worker.",
      inputSchema: { type: "object", additionalProperties: false, required: ["jobId", "detail"], properties: {
        jobId: { type: "string", description: "Coordinator job UUID." },
        detail: { type: "string", minLength: 1, description: "Specific verification evidence." }
      }}
    },
    { name: "preflight_goal", description: "Read the exact dispatch, goal-loop, worker, coordinator, and goal gates before an execution request. This never changes a gate.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    {
      name: "run_goal",
      description: "Execute an explicitly approved persistent goal through the proven Codex supervisor. It uses ephemeral per-run activation, keeps persistent dispatch disabled, and always returns the coordinator to paused. Exact writable paths are optional; omission is read-only.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["goalId"],
        properties: {
          goalId,
          writableWorkspacePaths: {
            type: "array",
            description: "Exact project-relative paths the isolated worker may edit and the host may apply after a verified checkpoint. Empty means read-only.",
            items: { type: "string", minLength: 1, maxLength: 500 }
          }
        }
      }
    },
  ];
}

export async function callTool(name, rawArguments, paths = productionPaths, backgroundOwner = null) {
  const args = object(rawArguments ?? {});
  if (name.startsWith("amadeus_")) {
    const options = paths?.stateRoot ? { stateRoot: paths.stateRoot } : {};
    if (name === "amadeus_discovery_preview") return discoveryPreview(args);
    if (name === "amadeus_discovery_run") return runDiscovery(args, { stateRoot: options.stateRoot ?? resolveStateRoot() });
    if (name === "amadeus_discovery_view") return { inventory: viewInventory(options.stateRoot ?? resolveStateRoot()) };
    if (name === "amadeus_discovery_delete") return deleteInventory(options.stateRoot ?? resolveStateRoot());
    if (name === "amadeus_onboarding_status") return onboardingStatus(options);
    if (name === "amadeus_setup") return setupPackagedRuntime(options);
    if (name === "amadeus_dependency_health") return dependencyHealth({
      ...options,
      cursorWorkerConfigPath: paths?.cursorWorkerConfig,
    });
    if (name === "amadeus_configure_runtime") return configureRuntime(args, options);
    if (name === "amadeus_provider_discovery_consent") return recordDiscoveryChoice(args, options);
    if (name === "amadeus_discover_tools") throw new Error("Use amadeus_discovery_preview and amadeus_discovery_run for optional inventory, or amadeus_dependency_health for routine checks.");
  } else {
    await ensureRuntime();
    paths ??= productionPaths;
  }
  if (name === "work_status") {
    const result = withCoordinator(paths.database, (c) => {
    const includeTechnical = args.includeTechnical === true;
    function view(goalId) {
      const result = { ...progressView(c, goalId, paths, includeTechnical), progressCursor: progressCursor(c, goalId) };
      result.liveProgress = liveProgressSummary(result);
      const active = activeRunForGoal(paths.database, goalId);
      const latest = lastRun(paths.database, goalId);
      if (pendingRuns(paths.database).some((item) => item.args.goalId === goalId)) return { ...result, state: "queued", message: "Authorized work is queued and will start automatically when the current worker finishes." };
      const backgroundAware = withBackgroundHostState(result, active);
      if (backgroundAware !== result) return backgroundAware;
      if (!result.done && (latest?.state === "failed" || latest?.state === "refused")) {
        return { ...result, state: "stopped_by_problem", message: latest.result?.error ?? latest.result?.blockers?.join("; ") ?? "The background run could not finish. Saved work is preserved." };
      }
      if (active?.goalId === goalId && result.state === "ready_to_start") return { ...result, state: "continuing", message: "The authorized background run is starting." };
      return result;
    }
    if (args.goalId !== undefined) return view(uuid(args.goalId));
    const goals = c.goals().goals;
    return {
      message: goals.length ? "Here is the current project work." : "No project work has been delegated yet.",
      work: goals.map((goal) => view(String(goal.id))),
    };
    });
    const originHostHandoff = result.state === "waiting_on_origin_host";
    const terminal = args.goalId !== undefined && (result.done || originHostHandoff || ["stopped", "stopped_by_problem", "checking_what_happened"].includes(result.state));
    if (terminal) return {
      ...result,
      completionAudit: await completionAudit(uuid(args.goalId), paths),
      ...(originHostHandoff ? { nextAction: "execute_origin_host_handoff_and_continue", keepOriginatingTurnOpen: true, doNotFinalize: true } : {}),
    };
    return result;
  }
  if (name === "completion_audit") return completionAudit(uuid(args.goalId), paths);
  if (name === "wait_for_work_update") {
    const goalId = uuid(args.goalId);
    const afterCursor = Number(args.afterCursor);
    if (!Number.isInteger(afterCursor) || afterCursor < 0) throw new Error("afterCursor must be a non-negative integer");
    const timeoutSeconds = args.timeoutSeconds === undefined ? 45 : Number(args.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error("timeoutSeconds must be a positive integer");
    return waitForWorkUpdate(goalId, afterCursor, Math.min(timeoutSeconds, 45), paths);
  }
  if (name === "delegate_work") {
    validateRoutePin(args);
    const created = await callTool("create_goal", {
      objective: text(args.task, "task"),
      successCriteria: text(args.doneWhen, "doneWhen"),
      constraints: text(args.boundaries, "boundaries"),
      idempotencyKey: args.idempotencyKey,
      executionProfile: args.executionProfile,
      projectRoot: args.projectRoot, provider: args.provider, model: args.model, reasoningEffort: args.reasoningEffort,
      pinRoute: args.pinRoute === true,
    }, paths);
    return withCoordinator(paths.database, (c) => ownerWorkView(c, String(created.goal.id)));
  }
  if (name === "start_work") {
    const beforeStart = withCoordinator(paths.database, (c) => ownerWorkView(c, uuid(args.goalId)));
    if (beforeStart.state === "waiting_on_origin_host") return {
      ...beforeStart,
      started: false,
      nextAction: "execute_origin_host_handoff_and_continue",
      keepOriginatingTurnOpen: true,
      doNotFinalize: true,
    };
    await attemptDeterministicRecoveryForGoal(uuid(args.goalId), paths);
    // A drained pause has no queued successor until resumed. Do that internally.
    withCoordinator(paths.database, (c) => {
      const goal = c.getGoal(uuid(args.goalId));
      if (goal.status === "paused" && !goal.current_job_id) {
        c.resumeGoal(String(goal.id));
        c.pauseGoal(String(goal.id));
      }
    });
    const result = await callTool("run_goal", { goalId: args.goalId, writableWorkspacePaths: args.writableWorkspacePaths }, paths);
    if (result.ready === false) {
      return { ...withCoordinator(paths.database, (c) => ownerWorkView(c, uuid(args.goalId))),
        state: "stopped_by_problem", started: false,
        message: "Work did not start. The coordinator found a setup problem that must be corrected.",
        blockers: result.blockers };
    }
    return { ...withCoordinator(paths.database, (c) => ({ ...ownerWorkView(c, uuid(args.goalId)), progressCursor: progressCursor(c, uuid(args.goalId)) })),
      started: !result.queued, queued: result.queued === true, state: result.queued ? "queued" : "continuing", nextAction: "wait_for_work_update", keepOriginatingTurnOpen: true, message: result.queued ? "Authorized work is queued and will start automatically after the current worker. Keep this chat turn open and immediately wait for the next progress event." : "Authorized work has been launched independently of this chat. Keep this chat turn open and immediately wait for the next progress event.",
      background: result.background };
  }
  if (name === "status") return withCoordinator(paths.database, (c) => c.status());
  if (name === "amadeus_lifecycle_status") {
    const stateRoot = paths?.stateRoot ?? resolveStateRoot({ setupRoot: paths?.setupRoot });
    return runLifecycleStatus({ stateRoot, pluginRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
  }
  if (name === "amadeus_update_consent") {
    const stateRoot = paths?.stateRoot ?? resolveStateRoot({ setupRoot: paths?.setupRoot });
    const updatePaths = defaultUpdatePaths(stateRoot);
    const consent = args.consent === true
      ? grantUpdateConsent(updatePaths.consentPath)
      : declineUpdateConsent(updatePaths.consentPath);
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    return { ok: true, consent, marketplaceUpgradeCommand: marketplaceUpgradeCommandFor(pluginRoot) };
  }
  if (name === "amadeus_check_updates") {
    const stateRoot = paths?.stateRoot ?? resolveStateRoot({ setupRoot: paths?.setupRoot });
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    // Codex and Claude packages carry different host manifests; read whichever this copy has.
    const currentVersion = readPluginVersion(pluginRoot) ?? "0.0.0";
    const marketplaceUpgradeCommand = marketplaceUpgradeCommandFor(pluginRoot);
    const result = await checkForUpdate({
      stateRoot,
      currentVersion,
      force: args.force === true,
      fetchLatestRelease: async ({ owner, name: repoName }) => {
        const url = `https://api.github.com/repos/${owner}/${repoName}/releases/latest`;
        const response = await fetch(url, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "amadeus-update-check" },
        });
        if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);
        return response.json();
      },
    });
    return { ...result, marketplaceUpgradeCommand };
  }
  if (name === "amadeus_discover_providers") {
    // Single consented discovery path: same as amadeus_discovery_run(local-providers).
    if (args.requested !== true) return { ok: false, status: 'request-required', collected: false };
    const stateRoot = paths?.stateRoot ?? resolveStateRoot({ setupRoot: paths?.setupRoot });
    return runDiscovery({
      requested: true,
      categories: ['local-providers'],
      locations: Array.isArray(args.locations) ? args.locations : [],
    }, { stateRoot });
  }
  if (name === "amadeus_approve_provider") {
    const stateRoot = paths?.stateRoot ?? resolveStateRoot({ setupRoot: paths?.setupRoot });
    const registryPath = defaultRegistryPath(stateRoot);
    let reg = loadRegistry(registryPath);
    reg = approveProvider(reg, text(args.providerId, "providerId", 200), args.approval === true);
    if (args.approval === true && args.enable === true) {
      reg = enableProvider(reg, text(args.providerId, "providerId", 200), true);
    }
    if (args.approval !== true) {
      reg = enableProvider(reg, text(args.providerId, "providerId", 200), false);
    }
    saveRegistry(registryPath, reg);
    return {
      ok: true,
      provider: reg.providers[text(args.providerId, "providerId", 200)],
      routingAuthority: false,
      localRouting: stableChannelLocalRoutingStatus(),
      note: "Approval/enable still require capability qualification before any routing authority. Stable channel keeps local automatic routing disabled.",
    };
  }
  if (name === "list_goals") return withCoordinator(paths.database, (c) => {
    if (args.goalId === undefined) return c.goals();
    return goalSummary(c, uuid(args.goalId));
  });
  if (name === "goal_events") return withCoordinator(paths.database, (c) => c.goalEvents(uuid(args.goalId)));
  if (name === "create_goal") {
    validateRoutePin(args);
    const executionProfile = args.executionProfile === undefined
      ? "approved-public-project" : text(args.executionProfile, "executionProfile", 80);
    if (executionProfile !== "approved-public-project") {
      throw new Error("executionProfile is unsupported");
    }
    if (typeof args.projectRoot !== "string" || !args.projectRoot.trim()) {
      throw new Error("projectRoot is required for ordinary development goals");
    }
    if (!isAbsolute(args.projectRoot.trim())) {
      throw new Error("projectRoot must be an absolute folder path");
    }
    const target = guardInstalledPluginTarget(args.projectRoot.trim());
    if (!target.ok) {
      const stateRoot = paths?.stateRoot ?? resolveStateRoot({ setupRoot: paths?.setupRoot });
      const artifact = writeLocalRepairArtifact(stateRoot, {
        code: target.code,
        summary: text(args.objective, "objective").slice(0, 2000),
        successCriteria: text(args.successCriteria, "successCriteria").slice(0, 2000),
      });
      throw new Error(`${target.reason} Repair note saved locally: ${artifact.path}`);
    }
    const result = withCoordinator(paths.database, (c) => {
      const created = c.createGoal({
        objective: text(args.objective, "objective"),
        successCriteria: text(args.successCriteria, "successCriteria"),
      constraints: text(args.constraints, "constraints"),
      continuous: args.continuous === true,
      idempotencyKey: args.idempotencyKey === undefined
          ? `plugin:${new Date().toISOString()}:${randomUUID()}`
          : text(args.idempotencyKey, "idempotencyKey", 160),
        reserveCredits: 1,
        projectRoot: args.projectRoot,
      });
      const goal = created.goal;
      if (!created.duplicate && goal.status === "active") c.pauseGoal(String(goal.id));
      return { ...created, ...goalSummary(c, String(goal.id)) };
    });
    await createDefaultGoalPackage(String(result.goal.id), paths, args);
    return {
      ...result,
      executionProfile,
      executionPackage: goalPackagePath(paths.packagesRoot, String(result.goal.id)),
    };
  }
  if (name === "pause_goal") {
    cancelPending(paths.database, uuid(args.goalId));
    const run = activeRunForGoal(paths.database, uuid(args.goalId));
    if (run?.goalId === uuid(args.goalId)) await writeFile(join(run.directory, "pause-requested"), "pause");
    return withCoordinator(paths.database, (c) => c.getGoal(uuid(args.goalId)).status === "paused" ? c.getGoal(uuid(args.goalId)) : c.pauseGoal(uuid(args.goalId)));
  }
  if (name === "resume_goal") return withCoordinator(paths.database, (c) => c.resumeGoal(uuid(args.goalId)));
  if (name === "retry_failed_goal") return withCoordinator(paths.database, (c) => c.retryFailedGoal(uuid(args.goalId), text(args.reason, "reason")));
  if (name === "answer_goal") return withCoordinator(paths.database, (c) => c.answerGoal(uuid(args.goalId), text(args.answer, "answer")));
  if (name === "stop_goal") { cancelPending(paths.database, uuid(args.goalId)); return withCoordinator(paths.database, (c) => c.stopGoal(uuid(args.goalId), text(args.reason, "reason"))); }
  if (name === "verify_job_receipt") return verifyJobReceipt(uuid(args.jobId, "jobId"), paths, true);
  if (name === "reconcile_job") {
    const observed = text(args.observed, "observed", 16);
    if (!["completed", "blocked", "failed", "queued"].includes(observed)) throw new Error("observed must be completed, blocked, failed, or queued");
    const jobId = uuid(args.jobId, "jobId");
    const shouldRecoverUsage = args.recoverVerifiedUsage === true
      || (args.recoverVerifiedUsage !== false && ["completed", "blocked"].includes(observed));
    const isGoalJob = withCoordinator(paths.database, (c) => Boolean(c.getJob(jobId).goal_id));
    // An uncertain goal job may be closed as completed only on a verified worker
    // receipt that itself records a complete decision. Host-verified work uses
    // complete_external_verification, which the completion audit labels as such.
    const recovery = shouldRecoverUsage || (observed === "completed" && isGoalJob)
      ? await verifyJobReceipt(jobId, paths, true) : null;
    if (observed === "completed" && isGoalJob && recovery?.goalDecision?.status !== "complete") {
      throw new Error("A goal job can be reconciled as completed only when its worker receipt verifies and records a complete decision. "
        + "Reconcile it as blocked, failed or queued, or use complete_external_verification for work the host verified.");
    }
    return withCoordinator(paths.database, (c) => {
      let recoveredUsage = null;
      if (recovery?.usage && (c.usage(jobId).records).length === 0) {
        const job = c.getJob(jobId);
        recoveredUsage = c.recordUsage({
          jobId,
          attempt: recovery.attempt,
          model: routedModelForJob(c, jobId) ?? "unknown",
          usage: recovery.usage,
          reservedCredits: Number(job.reserved_credit_micros) / 1_000_000,
        });
      }
      c.reconcile(jobId, observed, text(args.detail, "detail"));
      const job = c.getJob(jobId);
      return { job, goal: job.goal_id ? c.getGoal(String(job.goal_id)) : null, recoveredUsage };
    });
  }
  if (name === "complete_external_verification") {
    const jobId = uuid(args.jobId, "jobId");
    // Record what the worker's own verified receipt decided, if one exists, so a
    // host completion that contradicts a blocked receipt can be reopened later.
    let receiptDecisionStatus = null;
    try { receiptDecisionStatus = (await verifyJobReceipt(jobId, paths, true, true))?.goalDecision?.status ?? null; }
    catch { receiptDecisionStatus = null; }
    return withCoordinator(paths.database, (c) => c.completeExternallyVerifiedGoalIteration(jobId, text(args.detail, "detail"), receiptDecisionStatus));
  }
  if (name === "preflight_goal" || name === "run_goal") {
    const goalId = uuid(args.goalId);
    if (name === "run_goal") await attemptDeterministicRecoveryForGoal(goalId, paths);
    const operations = await jsonFile(paths.operations);
    const worker = await jsonFile(paths.workerConfig);
    const cursorWorker = await optionalJsonFile(paths.cursorWorkerConfig, {});
    const cursorAcceleratorPresent = existsSync(paths.cursorWorkerConfig)
      && cursorWorker.enabled === true
      && cursorWorker.dispatchAuthorized === true;
    const snapshot = withCoordinator(paths.database, (c) => ({ status: c.status(), uncertainConflict: c.hasUncertainConflict(goalId),
      runningConflict: c.hasRunningConflict(goalId), ...goalSummary(c, goalId) }));
    const blockers = [];
    const descriptorPath = goalPackagePath(paths.packagesRoot, goalId);
    const descriptor = await jsonFile(descriptorPath);
    const development = descriptor.developmentMode === true;
    if (development) {
      operations.dispatch.provider = descriptor.provider ?? operations.dispatch.provider;
      operations.dispatch.model = normalizeRouteModel(descriptor.model ?? operations.dispatch.model);
      operations.dispatch.reasoningEffort = descriptor.reasoningEffort ?? operations.dispatch.reasoningEffort;
      if (operations.dispatch.provider === "cursor-browser-login" && cursorAcceleratorPresent) Object.assign(worker, cursorWorker);
      worker.developmentMode = true;
      worker.model = normalizeRouteModel(descriptor.model ?? (operations.dispatch.provider === "cursor-browser-login" ? null : operations.dispatch.model));
      worker.reasoningEffort = operations.dispatch.reasoningEffort;
      // Network access stays an explicit owner opt-in, and the configured runtime
      // ceiling (default 4 hours) still applies to unattended development workers.
      worker.commandNetworkEnabled = worker.commandNetworkEnabled === true;
      worker.maximumRuntimeSeconds = Number(worker.maximumRuntimeSeconds) > 0 ? Number(worker.maximumRuntimeSeconds) : 14400;
      worker.deniedSourceRoot = (await jsonFile(join(dirname(descriptorPath), descriptor.stages[0].manifest))).source.projectRoot;
    }
    const observedActive = activeRun(paths.database, snapshot.goal.project_root);
    // A preserved dead-run receipt is evidence, not a live worker. It must not
    // prevent source refresh or make a new bounded run look concurrent.
    const active = observedActive?.alive === false ? null : observedActive;
    if (name === "run_goal" && development && !active && snapshot.currentJob?.status === "queued") {
      refreshRepeatGoalPackage({ packagePath: descriptorPath, goalId, writableWorkspacePaths: ["."] });
    }
    const canQueue = active && active.alive !== false && active.goalId && active.goalId !== goalId && !backgroundOwner;
    if (active && active.runId !== backgroundOwner && !canQueue) blockers.push("This goal is already running or its prior process needs reconciliation.");
    let requestedWritablePaths = name === "run_goal" ? writableWorkspacePaths(args.writableWorkspacePaths) : null;
    const packagePath = goalPackagePath(paths.packagesRoot, goalId);
    let packageStage = null;
    try {
      if (!snapshot.currentJob) throw new Error("current goal job is unavailable");
      packageStage = inspectGoalExecutionPackage(packagePath, goalId, Number(snapshot.currentJob.package_stage_iteration ?? snapshot.currentJob.goal_iteration), true);
      if (packageStage.stage.handoff) {
        const handoff = packageStage.stage.handoff;
        const previous = withCoordinator(paths.database, (c) => c.getGoalPackageStageJob(goalId, handoff.fromIteration));
        if (!previous?.result_artifact_path || !existsSync(previous.result_artifact_path)) throw new Error("Previous stage has no saved result for handoff");
        const patch = withCoordinator(paths.database, (c) => c.patchReceipts(String(previous.id)).records.at(-1));
        if (handoff.requirePatch && (!patch?.patch_path || !existsSync(patch.patch_path))) throw new Error("Previous stage has no saved patch for handoff");
      }
    } catch (error) {
      blockers.push(`goal execution package is not ready: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (name === "run_goal" && args.writableWorkspacePaths === undefined && packageStage && Array.isArray(packageStage.stage.allowedWritableWorkspacePaths)) {
      requestedWritablePaths = [...packageStage.stage.allowedWritableWorkspacePaths];
    }
    if (requestedWritablePaths && packageStage && Array.isArray(packageStage.stage.allowedWritableWorkspacePaths)) {
      const expected = [...packageStage.stage.allowedWritableWorkspacePaths].sort();
      const actual = [...requestedWritablePaths].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        blockers.push(`current package stage requires exactly these writable paths: ${expected.join(", ") || "none"}`);
      }
    }
    if (!development && operations.dispatch?.provider !== "codex-chatgpt-signin") blockers.push("Non-development goals run only on the Codex adapter");
    if (operations.dispatch?.windowsSandbox !== "mxc") blockers.push("the reviewed MXC worker sandbox configuration changed");
    if (operations.dispatch?.approvalPolicy !== "never") blockers.push("Unattended workers cannot request interactive approval");
    if (operations.dispatch.provider !== "cursor-browser-login" && worker.windowsSandbox !== "mxc") blockers.push("Codex adapter MXC configuration changed");
    const cursorProblem = cursorRoutePreflightProblem({
      development,
      provider: operations.dispatch.provider,
      cursorAcceleratorPresent,
      cursorWorker,
    });
    if (cursorProblem) blockers.push(cursorProblem);
    if (snapshot.goal.status !== "paused" && snapshot.goal.status !== "active") blockers.push(`goal status ${snapshot.goal.status} cannot be run`);
    const installedTarget = snapshot.goal.project_root ? guardInstalledPluginTarget(String(snapshot.goal.project_root)) : { ok: true };
    if (!installedTarget.ok) blockers.push(installedTarget.reason);
    if (!snapshot.currentJob || snapshot.currentJob.status !== "queued") blockers.push("current goal job is not queued");
    if (snapshot.uncertainConflict || (snapshot.runningConflict && !canQueue)) blockers.push("a running or uncertain process affecting this project must be resolved first");
    const reservationCredits = snapshot.currentJob ? Number(snapshot.currentJob.reserved_credit_micros) / 1_000_000 : 0;
    const preflight = {
      ready: blockers.length === 0,
      blockers,
      coordinatorPaused: snapshot.status.paused,
      outstandingReservationCredits: snapshot.status.outstandingReservationCredits,
      goal: snapshot.goal,
      currentJob: snapshot.currentJob,
      dispatch: {
        operationsEnabled: operations.enabled === true,
        goalLoopEnabled: operations.goalLoop?.enabled === true,
        provider: operations.dispatch?.provider,
        model: operations.dispatch?.model,
        reasoningEffort: operations.dispatch?.reasoningEffort,
        workerEnabled: worker.enabled === true,
        paidDispatchEnabled: worker.paidDispatchEnabled === true,
        maximumEstimatedCredits: Number(worker.maximumEstimatedCredits),
      },
      accelerators: {
        cursorOptional: true,
        cursorPresent: cursorAcceleratorPresent,
        baseline: "ordinary-software+available-codex-gpt-models",
        missingCursorBlocksWork: false,
      },
      explicitRun: {
        activation: "ephemeral-child-process-only",
        reservationCredits,
        persistentConfigurationRemainsDisabled: true,
      },
      executionPackage: packageStage ? {
        path: packagePath,
        stage: packageStage.stage.name,
        role: packageStage.stage.role,
        manifestSha256: packageStage.manifestValidation.manifestSha256,
        sourceFiles: packageStage.manifestValidation.files,
        sourceBytes: packageStage.manifestValidation.bytes,
        allowedWritableWorkspacePaths: packageStage.stage.allowedWritableWorkspacePaths,
        patchPolicy: packageStage.stage.patchPolicy,
        maximumChangedFiles: packageStage.stage.maximumChangedFiles,
        maximumChangedLines: packageStage.stage.maximumChangedLines,
      } : null,
    };
    if (name === "preflight_goal" || blockers.length) return preflight;
    if (!backgroundOwner) return launchBackground(fileURLToPath(import.meta.url), { ...args, projectRoot: snapshot.goal.project_root }, paths);
    const allowedPaths = args.writableWorkspacePaths === undefined && development ? ["."] : requestedWritablePaths ?? [];
    const temporaryRoot = mkdtempSync(join(tmpdir(), "amadeus-run-"));
    const temporaryOperations = join(temporaryRoot, "operations.json");
    const temporaryWorker = join(temporaryRoot, "worker.json");
    await writeFile(temporaryOperations, `${JSON.stringify({
      ...operations,
      enabled: true,
      goalLoop: { ...operations.goalLoop, enabled: true },
    }, null, 2)}\n`, "utf8");
    await writeFile(temporaryWorker, `${JSON.stringify({
      ...worker,
      enabled: true,
      paidDispatchEnabled: true,
      automaticStartup: false,
      maximumEstimatedCredits: reservationCredits,
      writableWorkspacePaths: allowedPaths,
      ...(development ? { dispatchAuthorized: true, implementationDispatchAuthorized: true, implementationPrepared: true, readOnlyOnly: false } : {}),
    }, null, 2)}\n`, "utf8");
    try {
      const activationCoordinator = new Coordinator(paths.database);
      try {
        const run = activeRunForGoal(paths.database, goalId);
        if (run?.runId === backgroundOwner && existsSync(join(run.directory, "pause-requested"))) return { cancelled: true, reason: "Paused before worker launch" };
        if (activationCoordinator.getGoal(goalId).status === "paused") activationCoordinator.resumeGoal(goalId);
        activationCoordinator.resume();
        if (run?.runId === backgroundOwner && existsSync(join(run.directory, "pause-requested"))) return { cancelled: true, reason: "Paused before worker launch" };
      } finally { activationCoordinator.close(); }
      const result = await executeSupervisor(process.execPath, [
        paths.supervisor, "run-goal", "--db", paths.database, "--goal-id", goalId,
        "--goal-package", packagePath,
        "--operations-config", temporaryOperations, "--worker-config", temporaryWorker,
        "--cursor-worker-config", operations.dispatch.provider === "cursor-browser-login" ? temporaryWorker : paths.cursorWorkerConfig,
      ], dirname(paths.supervisor), activeRunForGoal(paths.database, goalId)?.directory ?? temporaryRoot);
      return {
        preflight,
        execution: JSON.parse(result.stdout),
        stderr: result.stderr || null,
        writableWorkspacePaths: allowedPaths,
        persistentConfigurationChanged: false,
      };
    } catch (error) {
      withCoordinator(paths.database, (coordinator) => {
        const goal = coordinator.getGoal(goalId);
        const job = goal.current_job_id ? coordinator.getJob(String(goal.current_job_id)) : null;
        if (job?.status === "running") coordinator.uncertain(String(job.id), "Supervisor process ended without a trustworthy terminal receipt");
      });
      throw error;
    } finally {
      const finalCoordinator = new Coordinator(paths.database);
      try { if (finalCoordinator.getGoal(goalId).status === "active") finalCoordinator.pauseGoal(goalId); }
      finally { finalCoordinator.close(); }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: AMADEUS_PRODUCT.pluginName, version: "0.3.8", title: `${AMADEUS_PRODUCT.displayName}  -  ${AMADEUS_PRODUCT.descriptor}` },
      instructions: onboardingInstructions + " Amadeus  -  Local AI Orchestrator by Mad Max Systems. Maestro is an alias for Amadeus with the same instructions, behavior, and orchestration engine. Use the current project's absolute path. Use included subscription allowance without artificial spending gates; ordinary tools first, inexpensive suitable models next. Missing roadmap-required development tools and dependencies are routine authorized setup: install and verify them automatically. During continuous-development or Long-Haul Autopilot work, repair orchestration defects and routine technical failures automatically with ordinary software, verify the repair, and resume the same unfinished goal. If required evidence or tools are on another Amadeus worker, use read-only host reconciliation or package handoff; do not stop because a fresh worker root cannot see a preserved artifact. Continue bounded troubleshooting after technical failures, including safe alternate sources and worker-to-host reconciliation; do not stop while a safe route remains. If owner action is genuinely required, surface one concrete plain-language question naming the action and purpose; never expose only an owner-gated or approval-required label. Before ending any turn, re-read the exact goal; if it is active, keep waiting, and if it is terminal, report the exact terminal state. Never claim a stale or different goal is still active. Continue authorized work until finished or genuinely blocked. Preserve unfinished work and report completion only with evidence.",
    } });
    return;
  }
  if (message.method === "ping") { send({ jsonrpc: "2.0", id: message.id, result: {} }); return; }
  if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools: toolDefinitions() } }); return; }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id: message.id, result: { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (error) {
      // Release path defers private fault intake; surface the tool error only.
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
    }
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}

async function selfTest() {
  await ensureRuntime();
  const root = mkdtempSync(join(tmpdir(), "amadeus-plugin-"));
  const database = join(root, "test.sqlite");
  const fakeSupervisor = join(root, "fake-supervisor.mjs");
  const failingSupervisor = join(root, "failing-supervisor.mjs");
  await writeFile(fakeSupervisor, `
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const operations = JSON.parse(readFileSync(value("--operations-config"), "utf8"));
const worker = JSON.parse(readFileSync(value("--worker-config"), "utf8"));
const goalPackage = JSON.parse(readFileSync(value("--goal-package"), "utf8"));
if (operations.enabled !== true || operations.goalLoop?.enabled !== true) throw new Error("ephemeral operations config is not active");
if (worker.enabled !== true || worker.paidDispatchEnabled !== true || worker.automaticStartup !== false) throw new Error("ephemeral worker config is not active");
if (worker.maximumEstimatedCredits !== 1 || worker.writableWorkspacePaths.length !== 0) throw new Error("ephemeral run envelope changed");
if (goalPackage.mode !== "repeat" || goalPackage.stages[0].role !== "development") throw new Error("goal package was not supplied");
console.log(JSON.stringify({ fake: true, goalId: value("--goal-id") }));
`, "utf8");
  await writeFile(failingSupervisor, `process.stderr.write("deterministic supervisor failure\\n"); process.exit(7);\n`, "utf8");
  const c = new Coordinator(database);
  c.configureSpendingLimit(100);
  c.configureCreditLimits({ perJob: 5, daily: 20, weekly: 50 });
  c.close();
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  const sourceFile = join(source, "README.md");
  await writeFile(sourceFile, "fixture\n", "utf8");
  const sourceBytes = await readFile(sourceFile);
  const workerManifest = join(root, "worker-source-manifest.json");
  await writeFile(workerManifest, JSON.stringify({
    schemaVersion: 1,
    source: { projectRoot: source, baseRevision: "fixture" },
    files: [{ path: "README.md", bytes: sourceBytes.length, sha256: sha256(sourceBytes) }],
  }), "utf8");
  const paths = {
    ...productionPaths,
    database,
    stateRoot: root,
    operations: join(root, 'operations-review.json'),
    workerConfig: join(root, 'worker-config.json'),
    cursorWorkerConfig: join(root, 'cursor-worker-config.json'),
    supervisor: fakeSupervisor,
    workerManifest,
    packagesRoot: join(root, "goal-packages"),
  };
  for (const name of ['operations-review.json', 'worker-config.json', 'cursor-worker-config.json']) {
    await writeFile(join(root, name), await readFile(join(dirname(fileURLToPath(import.meta.url)), '../runtime/config-templates', name)));
  }
  const created = await callTool("delegate_work", {
    task: "Self-test objective", doneWhen: "Durable state is verified",
    boundaries: "No model calls", idempotencyKey: "self-test",
    projectRoot: source,
  }, paths);
  if (created.state !== "ready_to_start" || created.done !== false || created.technicalDetails !== undefined) {
    throw new Error("Self-test owner view is not simple and ready");
  }
  const goalId = String(created.workId);
  const statusBefore = await callTool("work_status", { goalId }, paths);
  if (statusBefore.goalId !== goalId || statusBefore.stage !== "Queued" || statusBefore.stateLabel !== "Queued" || !Number.isInteger(statusBefore.progressCursor)) {
    throw new Error("Self-test progress snapshot is not bound to durable queued state");
  }
  const immediateUpdate = await callTool("wait_for_work_update", { goalId, afterCursor: 0, timeoutSeconds: 1 }, paths);
  if (immediateUpdate.changed !== false || immediateUpdate.progressCursor !== statusBefore.progressCursor || immediateUpdate.progressEvents.length) {
    throw new Error("Self-test native progress wait did not ignore lifecycle events");
  }
  const timeoutUpdate = await callTool("wait_for_work_update", { goalId, afterCursor: statusBefore.progressCursor, timeoutSeconds: 1 }, paths);
  if (timeoutUpdate.changed !== false || timeoutUpdate.progressCursor !== statusBefore.progressCursor) {
    throw new Error("Self-test native progress wait did not time out cleanly");
  }
  const auditFixture = await callTool("create_goal", {
    objective: "Completion audit fixture", successCriteria: "Completion is reported separately from coordinator health",
    constraints: "No model calls", idempotencyKey: "self-test-completion-audit",
    projectRoot: source,
  }, paths);
  withCoordinator(database, (coordinator) => {
    coordinator.resume();
    coordinator.resumeGoal(String(auditFixture.goal.id));
    const claimed = coordinator.claim("self-test-audit", 60, String(auditFixture.goal.id));
    if (!claimed) throw new Error("Self-test completion audit fixture was not claimable");
    coordinator.finishGoalIteration(String(claimed.id), "Fixture complete", undefined, {
      status: "complete", summary: "Fixture complete", evidence: ["durable fixture"],
      remainingCriterion: null, nextObjective: null, question: null,
    });
    coordinator.pause();
  });
  const completedAuditView = await callTool("work_status", { goalId: auditFixture.goal.id }, paths);
  if (completedAuditView.done !== true || completedAuditView.completionAudit?.productResult !== "complete"
    || completedAuditView.completionAudit?.reportingOnly !== true || completedAuditView.completionAudit?.repairNeeded !== true) {
    throw new Error("Self-test completed work did not receive the temporary diagnostic audit");
  }
  const explicitAudit = await callTool("completion_audit", { goalId: auditFixture.goal.id }, paths);
  if (explicitAudit.goalId !== auditFixture.goal.id || explicitAudit.auditVersion !== 1) {
    throw new Error("Self-test explicit completion audit failed");
  }
  const listed = await callTool("list_goals", { goalId }, paths);
  if (listed.currentJob.status !== "queued") throw new Error("Self-test job is not queued");
  withCoordinator(database, (coordinator) => {
    const jobId = String(listed.currentJob.id);
    coordinator.recordAuditNote(jobId, "route_selected", JSON.stringify({ schemaVersion: 2,
      provider: "cursor-browser-login", model: "auto", reasoningEffort: "low",
      reason: "Routine implementation fixture", financialBasis: "subscription-suitability-not-price-comparison",
      routingPolicy: "balanced-quality", taskClass: "routine-implementation", capabilityTier: "cursor-auto",
      capabilitySignals: ["bounded repository implementation requested"], localModelCandidate: false }));
    coordinator.recordAuditNote(jobId, "route_step_completed", JSON.stringify({ schemaVersion: 1, step: "inspect",
      provider: "software", model: null, reasoningEffort: "none", financialBasis: "no-model", passed: true }));
    coordinator.recordAuditNote(jobId, "route_step_completed", JSON.stringify({ schemaVersion: 1, step: "execute",
      provider: "cursor-browser-login", model: "auto", reasoningEffort: "low",
      financialBasis: "subscription-suitability-not-price-comparison", passed: true }));
    coordinator.recordAuditNote(jobId, "route_step_completed", JSON.stringify({ schemaVersion: 1, step: "verify",
      provider: "software", model: null, reasoningEffort: "none", financialBasis: "no-model", passed: true }));
  });
  const routedView = await callTool("work_status", { goalId }, paths);
  const softwareSteps = routedView.economics.stepProviderBreakdown.find((entry) => entry.provider === "software");
  if (routedView.economics.routedSteps !== 3 || softwareSteps?.completedSteps !== 2
    || softwareSteps?.completedStepPercentage !== 66.7 || routedView.stepRoutingHistory.length !== 3
    || routedView.economics.allocationPercentages.find((entry) => entry.route === "Cursor")?.model !== "auto") {
    throw new Error("Self-test step routing allocation was not reported accurately");
  }
  const routedAudit = await callTool("completion_audit", { goalId }, paths);
  if (routedAudit.workAllocation.allocationPercentages.find((entry) => entry.route === "Cursor")?.model !== "auto") {
    throw new Error("Self-test completion report lost the recorded Cursor model");
  }
  const softwareAllocation = routedAudit.workAllocation.allocationPercentages.find((entry) => entry.route === "ordinary software");
  const cursorAllocation = routedAudit.workAllocation.allocationPercentages.find((entry) => entry.route === "Cursor");
  const costRoutingCheck = routedAudit.checks.find((check) => check.name === "cost_routing_justification");
  if (softwareAllocation?.percentage !== 66.7 || cursorAllocation?.percentage !== 33.3
    || routedAudit.workAllocation.actualChargePercentages !== null || costRoutingCheck?.status !== "pass") {
    throw new Error("Self-test completion audit routing percentages are inaccurate");
  }
  const preflight = await callTool("preflight_goal", { goalId }, paths);
  if (preflight.ready !== true || preflight.blockers.length) throw new Error("Self-test preflight did not accept the safe disabled baseline");
  const operationsBefore = await readFile(paths.operations);
  const workerBefore = await readFile(paths.workerConfig);
  const blockedConfig = join(root, "blocked-worker.json");
  await writeFile(blockedConfig, JSON.stringify({ ...JSON.parse(workerBefore), windowsSandbox: "unelevated" }));
  const blockedStart = await callTool("start_work", { goalId }, { ...paths, workerConfig: blockedConfig });
  if (blockedStart.state !== "stopped_by_problem" || blockedStart.started !== false || !blockedStart.blockers.length) throw new Error("Refused start was hidden from the owner");
  const run = await callTool("run_goal", { goalId, writableWorkspacePaths: [] }, paths, "self-test-synchronous");
  if (run.execution.fake !== true || run.persistentConfigurationChanged !== false) throw new Error("Self-test ephemeral execution failed");
  const simpleRun = await callTool("start_work", { goalId, writableWorkspacePaths: [] }, paths);
  if (simpleRun.state !== "continuing" || simpleRun.started !== true || simpleRun.done !== false || simpleRun.technicalDetails !== undefined) {
    throw new Error("Self-test simple start did not return an owner-facing result");
  }
  const deadline = Date.now() + 15_000;
  while (activeRun(database)) {
    if (Date.now() > deadline) throw new Error("Background self-test did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastRun(database, goalId)?.state !== "finished") throw new Error("Background self-test failed");
  if (!operationsBefore.equals(await readFile(paths.operations)) || !workerBefore.equals(await readFile(paths.workerConfig))) {
    throw new Error("Self-test persistent configuration changed");
  }
  const failedPaths = { ...paths, supervisor: failingSupervisor };
  let failed = false;
  try { await callTool("run_goal", { goalId, writableWorkspacePaths: [] }, failedPaths, "self-test-synchronous"); }
  catch { failed = true; }
  if (!failed) throw new Error("Self-test failing supervisor unexpectedly succeeded");
  const afterFailure = await callTool("list_goals", { goalId }, paths);
  if (afterFailure.goal.status !== "paused" || afterFailure.currentJob.status !== "queued") throw new Error("Self-test failure did not restore paused queued state");
  await callTool("resume_goal", { goalId }, paths);
  await callTool("pause_goal", { goalId }, paths);
  await callTool("stop_goal", { goalId, reason: "Self-test complete" }, paths);
  const uncertainCreated = await callTool("create_goal", {
    objective: "Reconciliation self-test", successCriteria: "Uncertain state is resolved",
    constraints: "No model calls", idempotencyKey: "self-test-reconcile",
    projectRoot: source,
  }, paths);
  const uncertainJobId = String(uncertainCreated.currentJob.id);
  withCoordinator(database, (coordinator) => coordinator.uncertain(uncertainJobId, "Deterministic self-test fixture"));
  const uncertainView = await callTool("work_status", { goalId: uncertainCreated.goal.id }, paths);
  if (uncertainView.state !== "checking_what_happened" || uncertainView.needsFromYou !== null || uncertainView.done !== false) {
    throw new Error("Self-test uncertainty leaked internal classification work to the owner");
  }
  let unverifiedCompletionRefused = false;
  try {
    await callTool("reconcile_job", {
      jobId: uncertainJobId, observed: "completed", detail: "Claimed complete without a receipt", recoverVerifiedUsage: false,
    }, paths);
  } catch { unverifiedCompletionRefused = true; }
  if (!unverifiedCompletionRefused) throw new Error("Self-test accepted an unverified goal completion");
  const reconciled = await callTool("reconcile_job", {
    jobId: uncertainJobId, observed: "failed", detail: "Fixture verified as failed",
  }, paths);
  if (reconciled.job.status !== "failed" || reconciled.goal.status !== "blocked") throw new Error("Self-test reconciliation failed");
  const handoffCreated = await callTool("create_goal", {
    objective: "Origin-host handoff fixture", successCriteria: "Host evidence is recorded",
    constraints: "No model calls", idempotencyKey: "self-test-origin-host-handoff", continuous: true,
    projectRoot: source,
  }, paths);
  const handoffGoalId = String(handoffCreated.goal.id);
  const handoffJob = withCoordinator(database, (coordinator) => {
    coordinator.resumeGoal(handoffGoalId);
    const job = coordinator.claim("self-test-origin-host", 60, handoffGoalId);
    if (!job) throw new Error("Self-test origin-host worker was not claimable");
    return job;
  });
  withCoordinator(database, (coordinator) => coordinator.finishGoalIteration(String(handoffJob.id), "Host evidence remains", undefined, {
    status: "blocked", summary: "Host evidence remains",
    evidence: ["M9_ORIGIN_HOST_HANDOFF.md"], nextObjective: null,
    nextStreamObjective: null, question: null, hostHandoff: { action: "Perform the authenticated readback" },
  }));
  const handoffView = await callTool("work_status", { goalId: handoffGoalId }, paths);
  if (handoffView.state !== "waiting_on_origin_host" || handoffView.stateLabel !== "Origin-host action"
    || handoffView.nextAction !== "execute_origin_host_handoff_and_continue" || handoffView.doNotFinalize !== true) {
    throw new Error("Self-test origin-host handoff was misreported as model work or terminal completion");
  }
  const handoffResume = await callTool("resume_goal", { goalId: handoffGoalId }, paths);
  if (handoffResume.nextAction !== "execute_origin_host_handoff_and_continue" || handoffResume.originHostHandoff?.evidence?.[0] !== "M9_ORIGIN_HOST_HANDOFF.md") {
    throw new Error("Self-test origin-host resume did not return the preserved handoff");
  }
  const handoffStart = await callTool("start_work", { goalId: handoffGoalId }, paths);
  if (handoffStart.started !== false || handoffStart.state !== "waiting_on_origin_host" || handoffStart.doNotFinalize !== true) {
    throw new Error("Self-test start_work launched a rediscovery worker for an origin-host handoff");
  }
  const handoffCursor = withCoordinator(database, (coordinator) => progressCursor(coordinator, handoffGoalId));
  const handoffWait = await callTool("wait_for_work_update", {
    goalId: handoffGoalId, afterCursor: handoffCursor, timeoutSeconds: 1,
  }, paths);
  if (handoffWait.nextAction !== "execute_origin_host_handoff_and_continue" || handoffWait.doNotFinalize !== true) {
    throw new Error("Self-test wait did not route the saved host action back to the originating turn");
  }
  const retried = await callTool("retry_failed_goal", {
    goalId: uncertainCreated.goal.id, reason: "Fixture failure cause corrected",
  }, paths);
  if (retried.status !== "paused" || Number(retried.current_iteration) !== 2) throw new Error("Self-test failed-goal replacement was not queued paused");
  const retriedState = await callTool("list_goals", { goalId: uncertainCreated.goal.id }, paths);
  if (retriedState.currentJob.status !== "queued") throw new Error("Self-test replacement job is not queued");
  const retriedView = await callTool("work_status", { goalId: uncertainCreated.goal.id }, paths);
  if (retriedView.state !== "ready_to_start" || retriedView.whatRemains === null) throw new Error("Self-test unfinished work was not preserved in the owner view");
  process.stdout.write(`${JSON.stringify({ ok: true, goalId, finalStatus: (await callTool("list_goals", { goalId }, paths)).goal.status, reconciliationStatus: reconciled.job.status, replacementStatus: retriedState.currentJob.status })}\n`);
}

if (process.argv.includes("--background-request")) {
  await runBackground(process.argv[process.argv.indexOf("--background-request") + 1],
    (request) => callTool("run_goal", request.args, request.paths, request.runId),
    (request) => {
      if (activeRuns(request.paths.database).length === 0) withCoordinator(request.paths.database, (coordinator) => coordinator.pause());
    });
} else if (process.argv.includes("--self-test")) {
  await selfTest();
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { void handle(JSON.parse(line)); }
      catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); }
    }
  });
}
