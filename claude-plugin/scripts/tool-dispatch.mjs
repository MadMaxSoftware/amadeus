/** MCP tool dispatch. */

import { dependencyHealth } from "./dependency-health.mjs";
import { deleteInventory, discoveryPreview, runDiscovery, viewInventory } from "./capability-discovery.mjs";
import { configureRuntime, onboardingStatus, recordDiscoveryChoice, setupPackagedRuntime } from "./privacy-onboarding.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { guardInstalledPluginTarget, writeLocalRepairArtifact } from "./self-repair-boundary.mjs";
import {
  activeRun,
  activeRunForGoal,
  cancelPending,
  executeSupervisor,
  lastRun,
  launchBackground,
  pendingRuns,
} from "./background-run.mjs";
import { fileURLToPath } from "node:url";
import { resolveStateRoot } from "./amadeus-runtime.mjs";
import {
  approveProvider,
  checkForUpdate,
  declineUpdateConsent,
  defaultRegistryPath,
  defaultUpdatePaths,
  enableProvider,
  grantUpdateConsent,
  loadRegistry,
  marketplaceUpgradeCommandFor,
  readPluginVersion,
  runLifecycleStatus,
  saveRegistry,
  stableChannelLocalRoutingStatus,
} from "./amadeus-lifecycle.mjs";
import {
  Coordinator,
  ensureRuntime,
  goalPackagePath,
  inspectGoalExecutionPackage,
  productionPaths,
  refreshRepeatGoalPackage,
  writeDevelopmentManifest,
} from "./server-runtime.mjs";
import {
  cursorRoutePreflightProblem,
  jsonFile,
  normalizeRouteModel,
  object,
  optionalJsonFile,
  sha256,
  text,
  uuid,
  validateRoutePin,
  withCoordinator,
  writableWorkspacePaths,
} from "./server-common.mjs";
import { attemptDeterministicRecoveryForGoal, routedModelForJob, verifyJobReceipt } from "./receipt-recovery.mjs";
import {
  goalSummary,
  isMeaningfulProgressEvent,
  liveProgressSummary,
  ownerWorkView,
  progressCursor,
  progressView,
  withBackgroundHostState,
} from "./work-views.mjs";
import { completionAudit } from "./completion-report.mjs";

export async function createDefaultGoalPackage(goalId, paths, options = {}) {
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

export async function waitForWorkUpdate(goalId, afterCursor, timeoutSeconds, paths) {
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

/** The subscription provider the host chat runs on, from this plugin package's manifest. */
export function hostProvider() {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(join(pluginRoot, ".claude-plugin", "plugin.json"))) return "claude-subscription-signin";
  if (existsSync(join(pluginRoot, ".codex-plugin", "plugin.json"))) return "codex-chatgpt-signin";
  return "unknown";
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
    if (!backgroundOwner) return launchBackground(fileURLToPath(new URL("./server.mjs", import.meta.url)), { ...args, projectRoot: snapshot.goal.project_root }, paths);
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
        "--host-provider", hostProvider(),
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
