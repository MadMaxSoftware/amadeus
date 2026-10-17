import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  parseCursorResult,
  runCursorImplementation,
  type CursorAdapterConfig,
} from "./cursor-adapter.ts";
import { DefiniteWorkerFailure, UntrustedWorkerReceiptError, type WorkerContext, type WorkerDriver, type WorkerResult } from "./orchestrator.ts";
import { materializeWorkspace, materializeWritableWorkspacePaths } from "./worker-isolation.ts";
import { extractLeadingJsonObject, parseGoalDecision, type GoalDecision } from "./goal-protocol.ts";
import { captureWorkerPatch, seedWorkspaceWithPatch } from "./worker-patch.ts";
import { prepareWorkspaceIsolationAcceptance } from "./workspace-isolation-acceptance.ts";
import { prepareWorkspaceRuntimeRoot, WORKER_RUNTIME_DIRECTORY } from "./worker-runtime-layout.ts";

export type CursorProgress = {
  phase: "analysis" | "command" | "edit" | "reporting";
  status: "started" | "completed" | "failed";
  summary: string;
  paths?: string[];
  important?: boolean;
};

/** Convert Cursor stream events into useful, privacy-safe owner checkpoints. */
export function parseCursorProgressLine(line: string, workspace: string): CursorProgress | null {
  let event: Record<string, any>;
  try { event = JSON.parse(line); } catch { return null; }
  if (event.type === "tool_call" && event.subtype === "started") {
    const call = event.tool_call && typeof event.tool_call === "object" ? event.tool_call : {};
    const name = Object.keys(call).find((key) => key.endsWith("ToolCall")) ?? "toolCall";
    if (/updateTodos/i.test(name)) return null;
    const rawPath = call[name]?.args?.path ?? call[name]?.args?.file_path ?? call[name]?.args?.filePath;
    const paths = typeof rawPath === "string" && rawPath
      ? (() => {
          const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspace, rawPath);
          const value = relative(resolve(workspace), absolute).replaceAll("\\", "/");
          return !value || value === ".." || value.startsWith("../") ? [] : [value];
        })()
      : [];
    if (/shell|command/i.test(name)) return { phase: "command", status: "started", summary: "Cursor is running a repository command." };
    if (/edit|write|apply|delete/i.test(name)) return {
      phase: "edit", status: "started",
      summary: paths.length ? `Cursor is changing project files: ${paths.join(", ")}` : "Cursor is changing project files.",
      ...(paths.length ? { paths } : {}),
    };
    return { phase: "analysis", status: "started", summary: "Cursor is inspecting project evidence." };
  }
  if (event.type === "system" && event.subtype === "task_notification" && event.status === "error") {
    return { phase: "command", status: "failed", summary: "A Cursor background check failed; Cursor is adapting.", important: true };
  }
  if (event.type === "assistant") {
    return { phase: "reporting", status: "completed", summary: "Cursor completed its implementation turn and is preparing the result.", important: true };
  }
  if (event.type === "thinking" && event.subtype === "completed") {
    return { phase: "analysis", status: "completed", summary: "Cursor completed a reasoning pass." };
  }
  return null;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${workspace}`, "-C", workspace, ...args], { encoding: "utf8" });
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
        else if (stats.isFile()) entries.push({ path: relativePath, bytes: stats.size,
          sha256: createHash("sha256").update(readFileSync(fullPath)).digest("hex").toUpperCase() });
      } catch { skipped.push(relativePath); }
    }
  };
  visit(workspace);
  return { files: entries, skipped };
}

export function parseCursorGoalDecision(stdout: string): GoalDecision {
  let finalAssistantText: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); }
    catch { continue; }
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const event = record as Record<string, unknown>;
    if (event.type !== "assistant" || typeof event.message !== "object" || event.message === null) continue;
    const content = (event.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => String(item.text))
      .join("");
    if (text.trim()) finalAssistantText = text;
  }
  if (finalAssistantText === null) throw new Error("Cursor goal stream did not contain a final assistant response");
  try {
    return parseGoalDecision(finalAssistantText);
  } catch (error) {
    const recovered = extractLeadingJsonObject(finalAssistantText);
    const suffix = recovered?.suffix.trim() ?? "";
    // A single valid decision followed by descriptive prose is safe to
    // normalize. Multiple JSON/control objects remain fail-closed.
    if (!recovered || !suffix || /^[\[{]/.test(suffix)) throw error;
    const decision = parseGoalDecision(recovered.json);
    decision.normalizations = [...(decision.normalizations ?? []), "discarded_cursor_trailing_prose"];
    return decision;
  }
}

/**
 * Disabled-by-config Cursor implementation driver. It reuses the existing
 * isolated workspace, supervisor heartbeat/stop path, patch envelope,
 * checkpoint, and guarded applicator. The adapter itself refuses to launch
 * until billing and OS-enforced write-isolation receipts are present.
 */
export class CursorWorkerDriver implements WorkerDriver {
  private readonly paths: {
    config: string;
    manifest: string;
    workspaceRoot: string;
    artifactRoot: string;
    heartbeatSeconds?: number;
    objectiveOverride?: string | null;
  };
  private readonly runImplementation: typeof runCursorImplementation;
  private readonly prepareAcceptance: typeof prepareWorkspaceIsolationAcceptance;

  constructor(paths: {
    config: string;
    manifest: string;
    workspaceRoot: string;
    artifactRoot: string;
    heartbeatSeconds?: number;
    objectiveOverride?: string | null;
  }, runImplementation: typeof runCursorImplementation = runCursorImplementation,
  prepareAcceptance: typeof prepareWorkspaceIsolationAcceptance = prepareWorkspaceIsolationAcceptance) {
    this.paths = paths;
    this.runImplementation = runImplementation;
    this.prepareAcceptance = prepareAcceptance;
  }

  async run(context: WorkerContext): Promise<WorkerResult> {
    let config = JSON.parse(readFileSync(this.paths.config, "utf8")) as CursorAdapterConfig;
    const workspaceId = `${context.jobId}-a${context.attempt}`;
    const { workspace } = materializeWorkspace({
      manifestPath: this.paths.manifest,
      workspaceRoot: this.paths.workspaceRoot,
      workspaceId,
    });
    config = { ...config, runtimeConfigurationRoot: prepareWorkspaceRuntimeRoot(workspace) };
    const jobConfigDirectory = resolve(join(config.runtimeConfigurationRoot, `${workspaceId}.cursor-config`));
    mkdirSync(this.paths.artifactRoot, { recursive: true });
    const resultArtifactPath = resolve(join(this.paths.artifactRoot, `${workspaceId}.cursor-result.jsonl`));
    const stderrArtifactPath = resolve(join(this.paths.artifactRoot, `${workspaceId}.cursor-stderr.txt`));
    const workspaceEvidencePath = resolve(join(this.paths.artifactRoot, `${workspaceId}.cursor-workspace-evidence.json`));
    const persistEvidence = (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => {
      writeFileSync(resultArtifactPath, evidence.stdout, "utf8");
      writeFileSync(stderrArtifactPath, evidence.stderr, "utf8");
      if (evidence.captureWorkspace) {
        const inventory = snapshotWorkspace(workspace);
        writeFileSync(workspaceEvidencePath, JSON.stringify({ workspacePath: workspace, capturedAt: new Date().toISOString(), ...inventory }, null, 2) + "\n", "utf8");
      }
    };
    persistEvidence({ stdout: "", stderr: "", captureWorkspace: true });
    materializeWritableWorkspacePaths(workspace, config.writableWorkspacePaths ?? []);
    const seed = context.seedPatch ? seedWorkspaceWithPatch(workspace, context.seedPatch) : null;
    config = this.prepareAcceptance({ adapter: "cursor", config, workspace,
      artifactRoot: this.paths.artifactRoot, workspaceId });
    const leaseAbort = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      try { context.heartbeat(); }
      catch (error) { heartbeatFailure = error; leaseAbort.abort(); }
    }, (this.paths.heartbeatSeconds ?? 60) * 1000);
    try {
      let lastProgressAt = 0;
      let lastProgressSignature = "";
      const result = await this.runImplementation(
        config,
        workspace,
        (this.paths.objectiveOverride?.trim() || context.objective) + (seed?.guidance ?? ""),
        jobConfigDirectory,
        AbortSignal.any([context.signal, leaseAbort.signal]),
        { onEvidence: (evidence) => {
          persistEvidence(evidence);
          for (const line of evidence.stdout.split(/\r?\n/).filter(Boolean).slice(-40)) {
            const progress = parseCursorProgressLine(line, workspace);
            if (!progress) continue;
            const signature = `${progress.phase}:${progress.status}:${progress.summary}`;
            const now = Date.now();
            if (!progress.important && signature === lastProgressSignature && now - lastProgressAt < 30_000) continue;
            if (!progress.important && now - lastProgressAt < 10_000) continue;
            lastProgressAt = now;
            lastProgressSignature = signature;
            const { important: _important, ...ownerProgress } = progress;
            context.progress?.(ownerProgress);
          }
        } },
      );
      persistEvidence({ ...result, captureWorkspace: true });
      if (heartbeatFailure) throw heartbeatFailure;
      if (result.evidenceError) throw new UntrustedWorkerReceiptError(`Cursor evidence preservation failed: ${result.evidenceError}`,
        { outcome: "Cursor execution ended with incomplete evidence; reconciliation required.", resultArtifactPath, workspacePath: workspace });
      if (result.aborted) throw new Error(`Cursor owner/lease aborted after preserving partial output and workspace evidence${heartbeatFailure ? `: ${String(heartbeatFailure)}` : ""}`);
      if (result.timedOut) throw new UntrustedWorkerReceiptError(
        `Cursor timeout classified as ${result.timeoutKind ?? "unknown"}; stdout=${result.stdout.length} bytes, stderr=${result.stderr.length} bytes; partial output and workspace evidence preserved`,
        { outcome: "Cursor execution timed out; preserved evidence requires reconciliation.", resultArtifactPath, workspacePath: workspace });
      if (result.signal || result.error) throw new Error(result.error ?? `Cursor ended with signal ${result.signal}`);
      if (result.exitCode !== 0) throw new DefiniteWorkerFailure(`Cursor rejected the job with exit ${result.exitCode}: ${result.stderr.trim()}`);
      const receipt = parseCursorResult(result.stdout);
      const workerResult: WorkerResult = {
        outcome: receipt.result,
        resultArtifactPath,
        workspacePath: workspace,
        providerUsage: {
          provider: "cursor",
          model: config.model,
          sessionId: receipt.sessionId,
          requestId: receipt.requestId,
          durationMs: receipt.durationMs,
          durationApiMs: receipt.durationApiMs,
          tokenUsageAvailable: receipt.usage !== null,
          inputTokens: receipt.usage?.inputTokens ?? null,
          cachedInputTokens: receipt.usage?.cacheReadTokens ?? null,
          cacheWriteInputTokens: receipt.usage?.cacheWriteTokens ?? null,
          outputTokens: receipt.usage?.outputTokens ?? null,
          actualProviderCredits: null,
        },
      };
      if (context.goalId) {
        try {
          workerResult.goalDecision = parseCursorGoalDecision(result.stdout);
        } catch (error) {
          throw new UntrustedWorkerReceiptError(
            `Cursor final goal receipt was invalid: ${error instanceof Error ? error.message : String(error)}`,
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
