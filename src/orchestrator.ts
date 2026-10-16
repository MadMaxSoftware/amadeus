import { Coordinator } from "./coordinator.ts";
import type { CodexUsage } from "./usage-accounting.ts";
import type { GoalDecision } from "./goal-protocol.ts";
import { listDirtyPaths, type MilestoneGitResult } from "./milestone-git.ts";
import { hasPostDriftHousekeepingEvidence, requiresPostDriftHousekeeping } from "./post-drift-housekeeping.ts";

export type PatchArtifact = {
  path: string;
  sha256: string;
  bytes: number;
  changedFiles: number;
  changedLines: number;
  semanticChangedLines?: number;
  lineEndingOnlyLines?: number;
  /** Project-relative paths reported by Git for deterministic test discovery. */
  changedPaths?: string[];
};

export type WorkerResult = {
  outcome: string;
  usage?: Partial<CodexUsage>;
  providerUsage?: {
    provider: string;
    model: string | null;
    sessionId: string;
    requestId: string | null;
    durationMs: number | null;
    durationApiMs: number | null;
    tokenUsageAvailable: boolean;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    outputTokens: number | null;
    actualProviderCredits: null;
  };
  resultArtifactPath?: string;
  patch?: PatchArtifact;
  goalDecision?: GoalDecision;
  /** Disposable isolated workspace used by the worker; never the authoritative project. */
  workspacePath?: string;
};

export type WorkerContext = {
  jobId: string;
  attempt: number;
  objective: string;
  reservedCredits: number;
  goalId: string | null;
  goalIteration: number | null;
  signal: AbortSignal;
  heartbeat: () => void;
  /** Sanitized product-work checkpoint; never a raw provider transcript. */
  progress?: (detail: WorkerProgress) => void;
};

export type WorkerProgress = {
  phase: "preparing" | "analysis" | "command" | "edit" | "research" | "reporting";
  status: "started" | "completed" | "failed";
  summary: string;
  paths?: string[];
};

export interface WorkerDriver {
  run(context: WorkerContext): Promise<WorkerResult>;
}

export interface CheckpointDriver {
  createVerifiedCheckpoint(jobId: string): Promise<string>;
}

export interface PatchApplicator {
  apply(patch: PatchArtifact, checkpointReceipt: string): Promise<void>;
}

export type VerificationReceipt = {
  passed: boolean;
  summary: string;
  evidence: string[];
  checks: Array<{ tool: string; command: string; exitCode: number | null; passed: boolean }>;
};

export interface VerificationDriver {
  verify(result: WorkerResult, context: WorkerContext): Promise<VerificationReceipt>;
}

export class DefiniteWorkerFailure extends Error {}

export class UntrustedWorkerReceiptError extends Error {
  readonly partialResult: WorkerResult;

  constructor(message: string, partialResult: WorkerResult) {
    super(message);
    this.name = "UntrustedWorkerReceiptError";
    this.partialResult = partialResult;
  }
}

export class Orchestrator {
  private active: { jobId: string; controller: AbortController } | null = null;
  private readonly coordinator: Coordinator;
  private readonly worker: WorkerDriver;
  private readonly checkpoint: CheckpointDriver;
  private readonly applicator: PatchApplicator;
  private readonly options: { workerName?: string; leaseSeconds?: number; maximumIdleSeconds?: number; model?: string; maximumChangedFiles?: number | null; maximumChangedLines?: number | null; patchPolicy?: "apply" | "capture-only";
    verifier?: VerificationDriver;
    routeStep?: { provider: string; model: string | null; reasoningEffort: string; financialBasis: string; reason: string };
    onVerifiedMilestone?: (input: {
      jobId: string;
      goalId: string;
      summary: string;
      patchSha256: string;
      changedPaths: string[];
      preDirtyPaths: string[];
      decisionStatus: GoalDecision["status"];
    }) => Promise<MilestoneGitResult | void> | MilestoneGitResult | void;
    /** Authoritative project root used only to snapshot pre-apply dirty paths for safe milestone Git. */
    milestoneProjectRoot?: string;
  };

  constructor(
    coordinator: Coordinator,
    worker: WorkerDriver,
    checkpoint: CheckpointDriver,
    applicator: PatchApplicator,
    options: {
      workerName?: string;
      leaseSeconds?: number;
      maximumIdleSeconds?: number;
      model?: string;
      maximumChangedFiles?: number | null;
      maximumChangedLines?: number | null;
      patchPolicy?: "apply" | "capture-only";
      verifier?: VerificationDriver;
      routeStep?: { provider: string; model: string | null; reasoningEffort: string; financialBasis: string; reason: string };
      onVerifiedMilestone?: (input: {
        jobId: string;
        goalId: string;
        summary: string;
        patchSha256: string;
        changedPaths: string[];
        preDirtyPaths: string[];
        decisionStatus: GoalDecision["status"];
      }) => Promise<MilestoneGitResult | void> | MilestoneGitResult | void;
      milestoneProjectRoot?: string;
    } = {},
  ) {
    this.coordinator = coordinator;
    this.worker = worker;
    this.checkpoint = checkpoint;
    this.applicator = applicator;
    this.options = options;
  }

  /** Sign-in must never inherit a previously resumed state. */
  initializeAfterSignIn(): void {
    this.coordinator.pause();
  }

  async runOnce(goalId?: string): Promise<Record<string, unknown> | null> {
    if (this.active) return null;
    const workerName = this.options.workerName ?? "amadeus-worker-1";
    const leaseSeconds = this.options.leaseSeconds ?? 600;
    const claimed = this.coordinator.claim(workerName, leaseSeconds, goalId);
    if (!claimed) return null;
    const jobId = String(claimed.id);
    const attempt = Number(claimed.attempt_count);
    const controller = new AbortController();
    this.active = { jobId, controller };
    // The provider adapters own idle detection and refresh their timers when
    // productive output arrives. A second orchestration-level timer measures
    // wall-clock duration instead, so it can abort a healthy long-running
    // provider at exactly the configured idle threshold.
    const stopMonitor = setInterval(() => {
      try {
        if (this.coordinator.stopRequested(jobId, workerName)) controller.abort();
      } catch {
        controller.abort();
      }
    }, 1000);
    let primaryStepRecorded = false;
    let verificationStepStarted = false;
    let verificationStepRecorded = false;
    let patchApplied = false;
    let preDirtyPaths: string[] = [];
    let pendingGitBrief: MilestoneGitResult | null = null;
    try {
      if (this.options.routeStep) {
        this.coordinator.recordAuditNote(jobId, "route_step_started", JSON.stringify({
          schemaVersion: 1, step: "execute", ...this.options.routeStep,
          summary: `Implementation started with ${this.options.routeStep.provider}${this.options.routeStep.model ? ` (${this.options.routeStep.model})` : ""}.`,
        }));
      }
      const result = await this.worker.run({
        jobId,
        attempt,
        objective: String(claimed.objective),
        reservedCredits: Number(claimed.reserved_credit_micros) / 1_000_000,
        goalId: claimed.goal_id ? String(claimed.goal_id) : null,
        goalIteration: claimed.goal_iteration === null || claimed.goal_iteration === undefined ? null : Number(claimed.goal_iteration),
        signal: controller.signal,
        heartbeat: () => { this.coordinator.heartbeat(jobId, workerName, leaseSeconds); },
        progress: (detail) => {
          this.coordinator.recordAuditNote(jobId, "worker_progress", JSON.stringify({ schemaVersion: 1, ...detail }));
        },
      });
      // An idle watchdog aborts the controller without creating an emergency
      // stop request. Only acknowledgeStopped when the coordinator actually
      // recorded an explicit stop request; otherwise preserve the real worker
      // failure/timeout outcome for reconciliation.
      if (this.coordinator.stopRequested(jobId, workerName)) {
        this.coordinator.acknowledgeStopped(jobId, "Emergency termination acknowledged; outcome requires reconciliation.");
        return this.coordinator.getJob(jobId);
      }
      if (result.usage && result.providerUsage) throw new Error("Worker returned conflicting usage receipts");
      if (result.usage) {
        this.coordinator.recordUsage({
          jobId,
          attempt,
          model: this.options.model ?? "codex-default",
          usage: result.usage,
          reservedCredits: Number(claimed.reserved_credit_micros) / 1_000_000,
        });
      } else if (result.providerUsage) {
        this.coordinator.recordProviderUsage({
          jobId,
          attempt,
          reservedCredits: Number(claimed.reserved_credit_micros) / 1_000_000,
          ...result.providerUsage,
        });
      } else {
        throw new Error("Worker returned no usage receipt");
      }
      if (this.options.routeStep) {
        this.coordinator.recordAuditNote(jobId, "route_step_completed", JSON.stringify({
          schemaVersion: 1, step: "execute", ...this.options.routeStep, passed: true,
        }));
        primaryStepRecorded = true;
      }
      if (result.goalDecision?.normalizations?.length) {
        this.coordinator.recordAuditNote(jobId, "goal_decision_normalized", JSON.stringify({
          schemaVersion: 1,
          normalizations: result.goalDecision.normalizations,
          status: result.goalDecision.status,
          resultArtifactPath: result.resultArtifactPath ?? null,
        }));
      }
      if (result.patch) {
        const goalObjective = claimed.goal_id
          ? String(this.coordinator.getGoal(String(claimed.goal_id)).objective)
          : String(claimed.objective);
        if (claimed.goal_id
          && requiresPostDriftHousekeeping(goalObjective, result.patch.changedPaths ?? [])
          && !hasPostDriftHousekeepingEvidence(result.goalDecision)) {
          const detail = "Post-drift housekeeping evidence is missing. The milestone must inspect active source/configuration/workflows/scripts/tests/docs for remnants made obsolete by the repair, remove or quarantine them, preserve historical evidence and unrelated dirty paths, then rerun focused verification.";
          const decision: GoalDecision = {
            status: "blocked",
            summary: detail,
            evidence: [
              `Changed paths requiring housekeeping review: ${(result.patch.changedPaths ?? []).join(", ") || "not reported"}`,
            ],
            nextObjective: null,
            question: null,
            recovery: {
              diagnosis: "A repair or direction-changing milestone returned without the required post-drift housekeeping disposition.",
              nextObjective: "Audit the changed implementation and adjacent active surfaces for redundant or obsolete remnants, remove or quarantine only those remnants, preserve historical evidence and unrelated dirty paths, add the required Housekeeping evidence item, and rerun focused verification before resuming the original outcome.",
              scope: "same-approved-scope",
            },
          };
          this.coordinator.recordAuditNote(jobId, "post_drift_housekeeping_required", JSON.stringify({
            schemaVersion: 1,
            changedPaths: result.patch.changedPaths ?? [],
            authoritativeWorkspaceModified: false,
          }));
          this.coordinator.finishGoalIteration(jobId, detail, result.resultArtifactPath, decision);
          return this.coordinator.getJob(jobId);
        }
        if ((result.patch.lineEndingOnlyLines ?? 0) >= 100
          && (result.patch.lineEndingOnlyLines ?? 0) > (result.patch.semanticChangedLines ?? result.patch.changedLines)) {
          const detail = `Patch rejected before checkpoint or apply: ${result.patch.lineEndingOnlyLines} line-ending-only changes exceed ${result.patch.semanticChangedLines ?? "unknown"} substantive changed lines.`;
          this.coordinator.recordAuditNote(jobId, "line_ending_churn_rejected", detail);
          this.coordinator.finish(jobId, "failed", detail);
          return this.coordinator.getJob(jobId);
        }
        if (result.patch.changedFiles > (this.options.maximumChangedFiles ?? Infinity)
          || result.patch.changedLines > (this.options.maximumChangedLines ?? Infinity)) {
          const detail = {
            schemaVersion: 1,
            reasonCode: "patch-envelope",
            patchPolicy: this.options.patchPolicy ?? "apply",
            resultArtifactPath: result.resultArtifactPath ?? null,
            patch: {
              path: result.patch.path,
              sha256: result.patch.sha256.toUpperCase(),
              bytes: result.patch.bytes,
              changedFiles: result.patch.changedFiles,
              changedLines: result.patch.changedLines,
            },
            configuredEnvelope: {
              maximumChangedFiles: this.options.maximumChangedFiles ?? null,
              maximumChangedLines: this.options.maximumChangedLines ?? null,
            },
            authoritativeWorkspaceModified: false,
          };
          if (this.options.patchPolicy === "capture-only") this.coordinator.recordAuditNote(jobId, "recoverable_failure", JSON.stringify({
            ...detail,
            failureClass: "policy-rejection",
            recoveryStrategy: "promote-preserved-capture",
          }));
          this.coordinator.finish(jobId, "failed", "Capture was preserved but exceeded the current changed-file or changed-line policy; nothing was applied.", result.resultArtifactPath);
          return this.coordinator.getJob(jobId);
        }
        if (this.options.patchPolicy === "capture-only") {
          this.coordinator.recordPatchReceipt({
            jobId,
            attempt,
            patchPath: result.patch.path,
            patchSha256: result.patch.sha256,
            patchBytes: result.patch.bytes,
            changedFiles: result.patch.changedFiles,
            changedLines: result.patch.changedLines,
            checkpointReceipt: "capture-only: authoritative workspace was not modified",
            applied: false,
          });
        } else {
        if (this.options.verifier) {
          this.coordinator.recordAuditNote(jobId, "route_step_started", JSON.stringify({
            schemaVersion: 1, step: "verify", provider: "software", model: null,
            financialBasis: "no-model", reason: "Independently verify the isolated change before authoritative apply.",
          }));
          verificationStepStarted = true;
          const receipt = await this.options.verifier.verify(result, {
            jobId, attempt, objective: String(claimed.objective),
            reservedCredits: Number(claimed.reserved_credit_micros) / 1_000_000,
            goalId: claimed.goal_id ? String(claimed.goal_id) : null,
            goalIteration: claimed.goal_iteration === null || claimed.goal_iteration === undefined ? null : Number(claimed.goal_iteration),
            signal: controller.signal,
            heartbeat: () => { this.coordinator.heartbeat(jobId, workerName, leaseSeconds); },
          });
          this.coordinator.recordAuditNote(jobId, "route_step_completed", JSON.stringify({
            schemaVersion: 1, step: "verify", provider: "software", model: null,
            financialBasis: "no-model", passed: receipt.passed, summary: receipt.summary,
            evidence: receipt.evidence, checks: receipt.checks,
          }));
          verificationStepRecorded = true;
          if (!receipt.passed) {
            const detail = `Independent ordinary-software verification failed before apply: ${receipt.summary}`;
            if (claimed.goal_id) {
              const decision: GoalDecision = {
                status: "blocked",
                summary: detail,
                evidence: [...receipt.evidence, ...receipt.checks.map((check) => `${check.command}: exit ${check.exitCode}`)],
                nextObjective: null,
                question: null,
                recovery: {
                  diagnosis: receipt.summary,
                  nextObjective: "Correct the verified local failure in the preserved workspace, perform post-drift housekeeping for any redundant artifacts exposed by the correction, rerun the failed check and focused tests, then resume the original milestone without repeating the failed operation unchanged.",
                  scope: "same-approved-scope",
                },
              };
              this.coordinator.recordAuditNote(jobId, "verification_recovery_required", JSON.stringify({
                schemaVersion: 1,
                summary: receipt.summary,
                evidence: receipt.evidence,
                checks: receipt.checks,
                authoritativeWorkspaceModified: false,
              }));
              this.coordinator.finishGoalIteration(jobId, detail, result.resultArtifactPath, decision);
            } else {
              this.coordinator.finish(jobId, "failed", detail, result.resultArtifactPath);
            }
            return this.coordinator.getJob(jobId);
          }
        }
        let checkpointReceipt: string;
        try {
          checkpointReceipt = await this.checkpoint.createVerifiedCheckpoint(jobId);
        } catch (error) {
          this.coordinator.finish(jobId, "failed", `Verified pre-apply checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
          return this.coordinator.getJob(jobId);
        }
        if (this.options.onVerifiedMilestone && this.options.milestoneProjectRoot) {
          preDirtyPaths = listDirtyPaths(this.options.milestoneProjectRoot);
        }
        try {
          await this.applicator.apply(result.patch, checkpointReceipt);
        } catch (error) {
          this.coordinator.uncertain(jobId, `Patch application outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          return this.coordinator.getJob(jobId);
        }
        this.coordinator.recordPatchReceipt({
          jobId,
          attempt,
          patchPath: result.patch.path,
          patchSha256: result.patch.sha256,
          patchBytes: result.patch.bytes,
          changedFiles: result.patch.changedFiles,
          changedLines: result.patch.changedLines,
          checkpointReceipt,
          applied: true,
        });
        patchApplied = true;
        }
      }
      if (claimed.goal_id) {
        if (!result.goalDecision) throw new Error("Goal iteration returned no trustworthy structured decision");
        const decision = result.goalDecision;
        const shouldGit = Boolean(this.options.onVerifiedMilestone)
          && patchApplied
          && decision.status === "complete";
        // Commit/push after authoritative apply and before successor dispatch so the
        // push-status event is durable first; Git failures never block finish.
        if (shouldGit) {
          try {
            const gitResult = await this.options.onVerifiedMilestone!({
              jobId,
              goalId: String(claimed.goal_id),
              summary: result.outcome,
              patchSha256: result.patch!.sha256,
              changedPaths: result.patch?.changedPaths ?? [],
              preDirtyPaths,
              decisionStatus: decision.status,
            });
            if (gitResult) pendingGitBrief = gitResult;
          } catch (error) {
            const failed = {
              status: "failed" as const,
              branch: null,
              commit: null,
              commitMessage: null,
              remote: null,
              pushOutcome: "not_attempted" as const,
              reason: error instanceof Error ? error.message : String(error),
              brief: "",
            };
            failed.brief = `status=failed; commitMessage=(none); sha=(none); branch=(none); remote=(none); push=not_attempted; detail=${failed.reason}`;
            this.coordinator.recordMilestoneGitAutomation({
              jobId,
              goalId: String(claimed.goal_id),
              result: failed,
            });
            pendingGitBrief = failed;
          }
        }
        this.coordinator.finishGoalIteration(jobId, result.outcome, result.resultArtifactPath, decision);
        if (pendingGitBrief) {
          this.coordinator.attachMilestoneGitBrief(String(claimed.goal_id), pendingGitBrief.brief);
        }
      } else {
        this.coordinator.finish(jobId, "completed", result.outcome, result.resultArtifactPath);
      }
      return this.coordinator.getJob(jobId);
    } catch (error) {
      if (verificationStepStarted && !verificationStepRecorded) {
        this.coordinator.recordAuditNote(jobId, "route_step_completed", JSON.stringify({
          schemaVersion: 1, step: "verify", provider: "software", model: null,
          financialBasis: "no-model", passed: false,
          summary: error instanceof Error ? error.message : String(error),
        }));
      }
      if (this.options.routeStep && !primaryStepRecorded) {
        this.coordinator.recordAuditNote(jobId, "route_step_completed", JSON.stringify({
          schemaVersion: 1, step: "execute", ...this.options.routeStep, passed: false,
          summary: error instanceof Error ? error.message : String(error),
        }));
      }
      if (this.coordinator.stopRequested(jobId, workerName)) {
        this.coordinator.acknowledgeStopped(jobId, "Emergency termination acknowledged; outcome requires reconciliation.");
      } else if (error instanceof DefiniteWorkerFailure) {
        this.coordinator.finish(jobId, "failed", error.message);
      } else if (error instanceof UntrustedWorkerReceiptError) {
        const partial = error.partialResult;
        if (partial.usage) {
          this.coordinator.recordUsage({
            jobId,
            attempt,
            model: this.options.model ?? "codex-default",
            usage: partial.usage,
            reservedCredits: Number(claimed.reserved_credit_micros) / 1_000_000,
          });
        } else if (partial.providerUsage) {
          this.coordinator.recordProviderUsage({
            jobId,
            attempt,
            reservedCredits: Number(claimed.reserved_credit_micros) / 1_000_000,
            ...partial.providerUsage,
          });
        }
        this.coordinator.uncertain(
          jobId,
          `Worker completed with an untrusted final receipt: ${error.message}`,
          partial.resultArtifactPath,
        );
      } else {
        this.coordinator.uncertain(jobId, `Worker process ended without a trustworthy receipt: ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.coordinator.getJob(jobId);
    } finally {
      clearInterval(stopMonitor);
      this.active = null;
    }
  }

  stopNow(reason = "Owner requested immediate stop"): string[] {
    const stopping = this.coordinator.stopNow(reason);
    if (this.active && stopping.includes(this.active.jobId)) this.active.controller.abort();
    return stopping;
  }
}
