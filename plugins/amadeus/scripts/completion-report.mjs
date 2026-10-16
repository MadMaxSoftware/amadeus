/** Completion audit and the owner-facing completion report. */

import { jsonFile, withCoordinator } from "./server-common.mjs";
import {
  externallyVerifiedReceiptDisposition,
  providerExecutionFailed,
  structuredAuditDetail,
  verifyJobReceipt,
} from "./receipt-recovery.mjs";

export function auditCheck(name, status, summary, evidence = undefined) {
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

/**
 * Whether any recorded check exercised the project, or only patch integrity.
 * Older records carry no `kind`; their integrity checks are recognised by command.
 */
export function verificationDepth(recordedChecks, hostCommands = []) {
  const isIntegrity = (check) => check.kind ? check.kind === "integrity"
    : check.command === "git diff --check" || /workspace-diff-check/.test(String(check.command));
  const all = [...recordedChecks, ...hostCommands.map((command) => ({ command }))];
  const commands = [...new Set(all.map((check) => check.command))];
  const functional = all.filter((check) => !isIntegrity(check));
  if (!all.length) return { status: "not_exercised", summary: "No independent verification result was recorded.", commands };
  return functional.length
    ? { status: "pass", summary: "Independent product checks ran in addition to patch-integrity checking.", commands }
    : { status: "partial", summary: "Integrity check only: patch integrity was verified, but no project tests ran.", commands };
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

export async function completionAudit(goalId, paths) {
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
  const recordedChecks = verifyEvents.flatMap(({ detail }) => Array.isArray(detail.checks) ? detail.checks.filter((item) => item?.command) : []);
  const depth = verificationDepth(recordedChecks, recordedHostVerificationCommands(allEvents));
  checks.push(auditCheck("verification_depth", depth.status, depth.summary, { commands: depth.commands }));

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
      route: detail.provider === "codex-chatgpt-signin" ? "Codex"
        : detail.provider === "claude-subscription-signin" ? "Claude" : detail.provider ?? "unidentified provider",
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
