import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCodexInvocation, buildCodexSandboxCommand, runWorkerCommand } from "./codex-adapter.ts";
import type { VerificationDriver, VerificationReceipt, WorkerContext, WorkerResult } from "./orchestrator.ts";
import { portableWorkerConfig } from "./portable-runtime.ts";
import { resolveMaximumIdleSeconds } from "./worker-timeouts.ts";
import { prepareWorkspaceIsolationAcceptance } from "./workspace-isolation-acceptance.ts";
import {
  buildSandboxPipeCheck,
  changedLanguages,
  discoverVerificationChecks,
  isDirectWorkspaceIntegrityCheck,
  resolveSandboxTestRunner,
  verificationToolEnvironment,
  VERIFY_POLICY_PATH,
} from "./verification-checks.mjs";

export {
  buildSandboxPipeCheck,
  discoverVerificationChecks,
  isDirectWorkspaceIntegrityCheck,
  resolveSandboxTestRunner,
};

/** Says plainly that only patch integrity was checked, and which changed code went untested. */
export function integrityOnlySummary(changedPaths: string[] = []): string {
  const languages = changedLanguages(changedPaths);
  return "Integrity check only: the patch passed whitespace and integrity checks, but no project tests ran."
    + (languages.length ? ` Changed ${languages.join(", ")} code was not tested. Declare test commands in ${VERIFY_POLICY_PATH} (Python, Go, .NET) or package.json coordinator.verify (npm).` : "");
}

export class DeterministicVerifier implements VerificationDriver {
  private readonly options: { config: string; artifactRoot: string; runtimeHomeRoot: string; projectRoot: string;
    maximumRuntimeSeconds?: number; maximumIdleSeconds?: number };
  private readonly execute: typeof runWorkerCommand;

  constructor(options: DeterministicVerifier["options"], execute = runWorkerCommand) {
    this.options = options;
    this.execute = execute;
  }

  async verify(result: WorkerResult, context: WorkerContext): Promise<VerificationReceipt> {
    if (!result.workspacePath) throw new Error("Worker did not disclose its isolated workspace for independent verification");
    context.signal.throwIfAborted();
    const workspace = result.workspacePath;
    let config = JSON.parse(readFileSync(this.options.config, "utf8"));
    if (config.developmentMode) {
      config = portableWorkerConfig(config, this.options.projectRoot);
      const workspaceId = `${context.jobId}-a${context.attempt}`;
      const workerReceipt = join(this.options.artifactRoot, `${workspaceId}.codex-isolation.receipt.json`);
      config = existsSync(workerReceipt)
        ? { ...config, isolationVerified: true, isolationReceipt: workerReceipt }
        : prepareWorkspaceIsolationAcceptance({
          adapter: "codex",
          config,
          workspace,
          artifactRoot: this.options.artifactRoot,
          workspaceId,
        });
    }
    // Verification intentionally runs after the worker has produced a patch, so
    // the isolated checkout must be allowed to contain those pending changes.
    // Isolation/history/remote checks still run in verifyWorkspace.
    const permissions = buildCodexInvocation(config, workspace, "No model call", { allowWorkingChanges: true })
      .find((arg) => typeof arg === "string" && arg.startsWith("permissions."));
    if (!permissions) throw new Error("Independent verification could not derive the worker permission definition");
    const runtimeHome = join(this.options.runtimeHomeRoot, `${context.jobId}-a${context.attempt}-verify`);
    mkdirSync(runtimeHome, { recursive: true });
    mkdirSync(this.options.artifactRoot, { recursive: true });
    const evidencePath = join(this.options.artifactRoot, `${context.jobId}-a${context.attempt}.verification.json`);
    const outcomes: VerificationReceipt["checks"] = [];
    const raw: Array<Record<string, unknown>> = [];
    try {
      // Opt-in test commands come from the authoritative project, not the patched copy.
      for (const check of discoverVerificationChecks(workspace, result.patch?.changedPaths, { policyRoot: this.options.projectRoot })) {
        context.signal.throwIfAborted();
        context.heartbeat();
        // Strip host Cursor NODE_OPTIONS (--require path-verifier under C:\) so
        // nested Node in the Codex Windows sandbox does not EPERM on lstat('C:\\').
        const environment: Record<string, string> = { CODEX_HOME: runtimeHome, NODE_OPTIONS: "",
          ...verificationToolEnvironment(check.tool, runtimeHome) };
        // Fixed workspace integrity checks (`git diff --check`, workspace-diff-check)
        // run directly: nesting Codex Windows sandbox fails when the parent worker
        // already holds a restricted token. Every other repository-defined check
        // remains inside the normal Codex sandbox and fails closed if it cannot run.
        const directIntegrity = isDirectWorkspaceIntegrityCheck(check);
        const timeoutSec = this.options.maximumRuntimeSeconds ?? Math.max(60, Number(config.maximumRuntimeSeconds) || 600);
        const idleSec = this.options.maximumIdleSeconds ?? Math.max(30, resolveMaximumIdleSeconds(config, 120));
        const sandboxedArgs = directIntegrity
          ? check.args
          : buildCodexSandboxCommand(config, workspace, permissions, check.executable, check.args);
        const execution = await this.execute(directIntegrity ? check.executable : "codex", sandboxedArgs,
          workspace, timeoutSec, context.signal, environment, idleSec);
        const passed = execution.exitCode === 0 && !execution.timedOut && !execution.signal && !execution.error;
        outcomes.push({ tool: check.tool, kind: check.kind, command: check.command, exitCode: execution.exitCode, passed });
        raw.push({ ...check, ...execution });
        if (!passed) break;
      }
      const passed = outcomes.length > 0 && outcomes.every((check) => check.passed);
      const projectTestsRan = outcomes.some((check) => check.kind === "project-tests");
      const summary = !passed
        ? `${outcomes.find((check) => !check.passed)?.command ?? "Verification"} failed; the patch was not applied.`
        : projectTestsRan
          ? `${outcomes.length} independent ordinary-software check${outcomes.length === 1 ? "" : "s"} passed, including project tests.`
          : integrityOnlySummary(result.patch?.changedPaths);
      writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 1, modelInvoked: false, passed, projectTestsRan, summary, checks: outcomes, executions: raw }, null, 2));
      return { passed, projectTestsRan, summary, evidence: [evidencePath], checks: outcomes };
    } finally {
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  }
}
