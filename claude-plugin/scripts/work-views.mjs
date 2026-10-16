/** Owner-facing work status, progress views and the progress wait. */

import { readFileSync } from "node:fs";
import { activeRunForGoal } from "./background-run.mjs";
import { goalEventDetail, structuredAuditDetail } from "./receipt-recovery.mjs";
import { formatMilestoneGitOwnerSummary } from "./completion-report.mjs";

export function goalSummary(coordinator, goalId) {
  const goal = coordinator.getGoal(goalId);
  const job = goal.current_job_id ? coordinator.getJob(String(goal.current_job_id)) : null;
  return {
    goal,
    currentJob: job,
    goalEvents: coordinator.goalEvents(goalId),
  };
}

export const LIVE_JOB_STATUSES = new Set(["queued", "running", "waiting_question", "uncertain"]);

export function liveJobForGoal(coordinator, goal) {
  if (!goal.current_job_id) return null;
  const job = coordinator.getJob(String(goal.current_job_id));
  return LIVE_JOB_STATUSES.has(String(job.status)) ? job : null;
}

export function ownerWorkView(coordinator, goalId, includeTechnical = false) {
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

export function progressView(coordinator, goalId, paths, includeTechnical = false) {
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

export function progressCursor(coordinator, goalId) {
  const events = coordinator.goalEvents(goalId);
  return events.length ? Number(events.at(-1).sequence) : 0;
}

export const MEANINGFUL_PROGRESS_EVENT_KINDS = new Set([
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

export function describeProgressEvent(event) {
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
