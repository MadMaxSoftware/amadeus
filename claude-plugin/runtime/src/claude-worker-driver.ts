import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertClaudeImplementationDispatchAllowed,
  parseClaudeResult,
  runClaudeImplementation,
  type ClaudeAdapterConfig,
} from "./claude-adapter.ts";
import { DefiniteWorkerFailure, UntrustedWorkerReceiptError, type WorkerContext, type WorkerDriver, type WorkerResult } from "./orchestrator.ts";
import { materializeWorkspace, materializeWritableWorkspacePaths } from "./worker-isolation.ts";
import { parseGoalDecision } from "./goal-protocol.ts";
import { captureWorkerPatch, seedWorkspaceWithPatch } from "./worker-patch.ts";
import { prepareWorkspaceIsolationAcceptance } from "./workspace-isolation-acceptance.ts";
import { prepareWorkspaceRuntimeRoot, WORKER_RUNTIME_DIRECTORY } from "./worker-runtime-layout.ts";
import { portableClaudeConfig } from "./portable-runtime.ts";

export type ClaudeProgress = {
  phase: "preparing" | "analysis" | "command" | "edit" | "research" | "reporting";
  status: "started" | "completed" | "failed";
  summary: string;
  paths?: string[];
  important?: boolean;
  provider?: "claude-subscription-signin";
};

/** Convert a Claude stream-json event into a privacy-safe owner progress checkpoint. */
export function parseClaudeProgressLine(line: string, workspace: string): ClaudeProgress | null {
  let event: Record<string, any>;
  try { event = JSON.parse(line); }
  catch { return null; }
  if (event.type === "system" && event.subtype === "init") {
    return {
      phase: "analysis",
      status: "started",
      summary: "The Claude implementation turn started.",
      provider: "claude-subscription-signin",
    };
  }
  if (event.type === "result" && event.is_error !== true && event.subtype !== "error") {
    return {
      phase: "reporting",
      status: "completed",
      summary: "The Claude implementation turn completed and is preparing its result.",
      important: true,
      provider: "claude-subscription-signin",
    };
  }
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const toolUses = event.message.content.filter((part: any) => part?.type === "tool_use");
    if (toolUses.length === 0) return null;
    const names = toolUses.map((part: any) => String(part.name || "tool")).slice(0, 3);
    const paths = toolUses.flatMap((part: any) => {
      const raw = part.input?.file_path || part.input?.path || part.input?.filePath;
      if (typeof raw !== "string" || !raw) return [];
      const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw);
      const projectRelative = relative(resolve(workspace), absolute).replaceAll("\\", "/");
      return !projectRelative || projectRelative === ".." || projectRelative.startsWith("../") ? [] : [projectRelative];
    }).slice(0, 8);
    const isEdit = names.some((name: string) => /edit|write|apply|patch/i.test(name));
    const isShell = names.some((name: string) => /bash|shell|command/i.test(name));
    return {
      phase: isEdit ? "edit" : isShell ? "command" : "analysis",
      status: "started",
      summary: isEdit
        ? `Preparing Claude project file changes${paths.length ? `: ${paths.join(", ")}` : "."}`
        : isShell
          ? "Running a Claude repository command."
          : `Claude invoked ${names.join(", ")}.`,
      ...(paths.length ? { paths } : {}),
      provider: "claude-subscription-signin",
    };
  }
  return null;
}

function snapshotWorkspace(workspace: string): { files: Array<{ path: string; bytes: number; sha256: string }>; skipped: string[] } {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  const skipped: string[] = [];
  const ignoredDirectories = new Set([".git", WORKER_RUNTIME_DIRECTORY, ".pytest_cache", "node_modules", ".venv", "__pycache__", ".mypy_cache", ".ruff_cache"]);
  const visit = (directory: string) => {
    let names: string[];
    try { names = readdirSync(directory); }
    catch { skipped.push(directory.slice(workspace.length + 1).replaceAll("\\", "/") || "."); return; }
    for (const name of names) {
      if (ignoredDirectories.has(name)) {
        skipped.push(join(directory, name).slice(workspace.length + 1).replaceAll("\\", "/"));
        continue;
      }
      const fullPath = join(directory, name);
      const relativePath = fullPath.slice(workspace.length + 1).replaceAll("\\", "/");
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) visit(fullPath);
        else if (stats.isFile()) {
          entries.push({
            path: relativePath,
            bytes: stats.size,
            sha256: createHash("sha256").update(readFileSync(fullPath)).digest("hex").toUpperCase(),
          });
        }
      } catch { skipped.push(relativePath); }
    }
  };
  visit(workspace);
  return { files: entries.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200), skipped };
}

function parseClaudeGoalDecision(jsonl: string) {
  const receipt = parseClaudeResult(jsonl);
  return parseGoalDecision(receipt.result);
}

/**
 * Signed-in Claude worker driver. Host plugin installation never enables this
 * path; dispatch stays separately authorized and fail-closed without isolation.
 */
export class ClaudeWorkerDriver implements WorkerDriver {
  private readonly paths: {
    config: string;
    manifest: string;
    workspaceRoot: string;
    artifactRoot: string;
    heartbeatSeconds?: number;
    objectiveOverride?: string | null;
  };
  private readonly runImplementation: typeof runClaudeImplementation;
  private readonly prepareAcceptance: typeof prepareWorkspaceIsolationAcceptance;

  constructor(paths: {
    config: string;
    manifest: string;
    workspaceRoot: string;
    artifactRoot: string;
    heartbeatSeconds?: number;
    objectiveOverride?: string | null;
  }, runImplementation: typeof runClaudeImplementation = runClaudeImplementation,
  prepareAcceptance: typeof prepareWorkspaceIsolationAcceptance = prepareWorkspaceIsolationAcceptance) {
    this.paths = paths;
    this.runImplementation = runImplementation;
    this.prepareAcceptance = prepareAcceptance;
  }

  async run(context: WorkerContext): Promise<WorkerResult> {
    let config = JSON.parse(readFileSync(this.paths.config, "utf8")) as ClaudeAdapterConfig;
    // Development goals bind Claude to the same project scope as a Codex worker;
    // no separately prepared Claude (or Cursor) configuration is needed.
    if (config.developmentMode) {
      config = portableClaudeConfig(config, config.deniedSourceRoot, { stateRoot: dirname(resolve(this.paths.artifactRoot)) }) as ClaudeAdapterConfig;
    }
    const workspaceId = `${context.jobId}-a${context.attempt}`;
    const { workspace } = materializeWorkspace({
      manifestPath: this.paths.manifest,
      workspaceRoot: this.paths.workspaceRoot,
      workspaceId,
    });
    config = { ...config, runtimeConfigurationRoot: prepareWorkspaceRuntimeRoot(workspace) };
    const jobConfigDirectory = resolve(join(config.runtimeConfigurationRoot, `${workspaceId}.claude-config`));
    if (config.developmentMode) {
      // Command tools create profile folders (AppData etc.); give each job its own
      // writable profile inside its runtime folder instead of a shared one.
      config = { ...config, containedUserProfile: join(jobConfigDirectory, "profile") };
      mkdirSync(config.containedUserProfile, { recursive: true });
    }
    mkdirSync(this.paths.artifactRoot, { recursive: true });
    const resultArtifactPath = resolve(join(this.paths.artifactRoot, `${workspaceId}.claude-result.jsonl`));
    const stderrArtifactPath = resolve(join(this.paths.artifactRoot, `${workspaceId}.claude-stderr.txt`));
    const workspaceEvidencePath = resolve(join(this.paths.artifactRoot, `${workspaceId}.claude-workspace-evidence.json`));
    const persistEvidence = (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => {
      writeFileSync(resultArtifactPath, evidence.stdout, "utf8");
      writeFileSync(stderrArtifactPath, evidence.stderr, "utf8");
      if (evidence.captureWorkspace) {
        const inventory = snapshotWorkspace(workspace);
        writeFileSync(workspaceEvidencePath, `${JSON.stringify({ workspacePath: workspace, capturedAt: new Date().toISOString(), ...inventory }, null, 2)}\n`, "utf8");
      }
    };
    persistEvidence({ stdout: "", stderr: "", captureWorkspace: true });
    materializeWritableWorkspacePaths(workspace, config.writableWorkspacePaths ?? []);
    const seed = context.seedPatch ? seedWorkspaceWithPatch(workspace, context.seedPatch) : null;
    config = this.prepareAcceptance({ adapter: "claude", config, workspace,
      artifactRoot: this.paths.artifactRoot, workspaceId }) as ClaudeAdapterConfig;
    assertClaudeImplementationDispatchAllowed(config, workspace);
    const leaseAbort = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      try { context.heartbeat(); }
      catch (error) { heartbeatFailure = error; leaseAbort.abort(); }
    }, (this.paths.heartbeatSeconds ?? 60) * 1000);
    try {
      context.progress?.({
        phase: "preparing",
        status: "completed",
        summary: "Prepared the isolated Claude project workspace and verified its execution boundary.",
      });
      let lastProgressAt = 0;
      let lastProgressSignature = "";
      const runWith = (runConfig: ClaudeAdapterConfig) => this.runImplementation(
        runConfig,
        workspace,
        (this.paths.objectiveOverride?.trim() || context.objective) + (seed?.guidance ?? ""),
        jobConfigDirectory,
        AbortSignal.any([context.signal, leaseAbort.signal]),
        {
          onEvidence: (evidence) => {
            persistEvidence(evidence);
            for (const line of evidence.stdout.split(/\r?\n/).filter(Boolean).slice(-20)) {
              const progress = parseClaudeProgressLine(line, workspace);
              if (!progress) continue;
              const signature = `${progress.phase}:${progress.status}:${progress.summary}`;
              const now = Date.now();
              if (!progress.important && signature === lastProgressSignature && now - lastProgressAt < 30_000) continue;
              if (!progress.important && now - lastProgressAt < 10_000) continue;
              lastProgressAt = now;
              lastProgressSignature = signature;
              const { important: _important, provider: _provider, ...ownerProgress } = progress;
              context.progress?.(ownerProgress);
            }
          },
        },
      );
      let result = await runWith(config);
      // A tier alias Claude Code no longer accepts must not stop the goal: retry
      // once on Claude Code's own default model, before any work was done.
      if (result.exitCode !== 0 && !result.timedOut && !result.aborted && config.model
        && isUnknownClaudeModel(`${result.stdout}\n${result.stderr}`)) {
        context.progress?.({ phase: "preparing", status: "completed",
          summary: `${config.cli === "grok" ? "Grok" : "Claude"} did not accept the model "${config.model}"; using its default model instead.` });
        config = { ...config, model: null };
        result = await runWith(config);
      }
      persistEvidence({ ...result, captureWorkspace: true });
      if (heartbeatFailure) throw heartbeatFailure;
      if (result.evidenceError) {
        throw new UntrustedWorkerReceiptError(`Claude evidence preservation failed: ${result.evidenceError}`, {
          outcome: "Claude execution ended with incomplete evidence; reconciliation required.",
          resultArtifactPath,
          workspacePath: workspace,
        });
      }
      if (result.aborted) {
        throw new Error(`Claude owner/lease aborted after preserving partial output and workspace evidence${heartbeatFailure ? `: ${String(heartbeatFailure)}` : ""}`);
      }
      if (result.timedOut) {
        throw new UntrustedWorkerReceiptError(
          `Claude timeout classified as ${result.timeoutKind ?? "unknown"}; stdout=${result.stdout.length} bytes, stderr=${result.stderr.length} bytes; partial output and workspace evidence preserved`,
          { outcome: "Claude execution timed out; preserved evidence requires reconciliation.", resultArtifactPath, workspacePath: workspace },
        );
      }
      if (result.signal || result.error) throw new Error(result.error ?? `Claude ended with signal ${result.signal}`);
      if (result.exitCode !== 0) throw new DefiniteWorkerFailure(`Claude rejected the job with exit ${result.exitCode}: ${result.stderr.trim()}`);
      const receipt = parseClaudeResult(result.stdout);
      const workerResult: WorkerResult = {
        outcome: receipt.result,
        resultArtifactPath,
        workspacePath: workspace,
        providerUsage: {
          provider: config.cli === "grok" ? "grok" : "claude",
          model: config.model,
          sessionId: receipt.sessionId,
          requestId: receipt.requestId,
          durationMs: receipt.durationMs,
          durationApiMs: null,
          tokenUsageAvailable: receipt.usage !== null,
          inputTokens: receipt.usage?.inputTokens ?? null,
          cachedInputTokens: receipt.usage?.cacheReadTokens ?? null,
          cacheWriteInputTokens: receipt.usage?.cacheWriteTokens ?? null,
          outputTokens: receipt.usage?.outputTokens ?? null,
          actualProviderCredits: null,
        },
      };
      if (context.goalId) {
        try { workerResult.goalDecision = parseClaudeGoalDecision(result.stdout); }
        catch (error) {
          throw new UntrustedWorkerReceiptError(
            `Claude final goal receipt was invalid: ${error instanceof Error ? error.message : String(error)}`,
            workerResult,
          );
        }
      }
      workerResult.patch = captureWorkerPatch(workspace, config.writableWorkspacePaths ?? [], this.paths.artifactRoot, workspaceId);
      return workerResult;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

/** Claude Code's refusal of an unknown or unavailable --model value (not a usage limit or work failure). */
export function isUnknownClaudeModel(output: string): boolean {
  return /\bmodel\b[^\n]{0,120}\b(?:not found|not available|unknown|invalid|does not exist|is not supported|not_found_error)\b/i.test(output)
    || /\b(?:invalid|unknown|unsupported) model\b/i.test(output)
    || /\bnot_found_error\b[^\n]{0,200}\bmodel\b/i.test(output)
    || /issue with the selected model/i.test(output);
}
