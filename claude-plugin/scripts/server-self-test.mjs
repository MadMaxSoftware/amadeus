/** Packaged self-test (npm run amadeus:self-test). Makes no model calls. */

import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { activeRun, lastRun } from "./background-run.mjs";
import { fileURLToPath } from "node:url";
import { Coordinator, ensureRuntime, productionPaths } from "./server-runtime.mjs";
import { sha256, withCoordinator } from "./server-common.mjs";
import { progressCursor } from "./work-views.mjs";
import { callTool } from "./tool-dispatch.mjs";

export async function selfTest() {
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
