import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CheckpointDriver, PatchApplicator, PatchArtifact } from "./orchestrator.ts";
import { excludedDevelopmentPath } from "./development-project.ts";

export class LocalVerifiedCheckpointDriver implements CheckpointDriver {
  constructor(privateConfig: { script: string; config: string }) { this.options = privateConfig; }
  private readonly options: { script: string; config: string };

  async createVerifiedCheckpoint(jobId: string): Promise<string> {
    const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", this.options.script, "-ConfigPath", this.options.config, "-JobId", jobId], { encoding: "utf8" });
    const result = JSON.parse(output.trim()) as { receipt?: string; verified?: boolean };
    if (result.verified !== true || !result.receipt || !existsSync(result.receipt)) throw new Error("Verified checkpoint receipt is missing");
    return resolve(result.receipt);
  }
}

export class GuardedGitPatchApplicator implements PatchApplicator {
  private readonly projectRoot: string;
  private readonly workerConfigPath: string;
  private readonly artifactRoot: string;

  constructor(input: { projectRoot: string; workerConfig: string; artifactRoot: string }) {
    this.projectRoot = resolve(input.projectRoot);
    this.workerConfigPath = resolve(input.workerConfig);
    this.artifactRoot = resolve(input.artifactRoot);
  }

  async apply(patch: PatchArtifact, checkpointReceipt: string): Promise<void> {
    const patchPath = resolve(patch.path);
    const withinArtifacts = relative(this.artifactRoot.toLowerCase(), patchPath.toLowerCase());
    if (withinArtifacts.startsWith("..") || isAbsolute(withinArtifacts)) {
      throw new Error("Patch is outside the coordinator artifact root");
    }
    if (!existsSync(patchPath) || !existsSync(resolve(checkpointReceipt))) throw new Error("Patch or checkpoint receipt is missing");
    const patchBytes = readFileSync(patchPath);
    if (patchBytes.length !== patch.bytes || createHash("sha256").update(patchBytes).digest("hex").toUpperCase() !== patch.sha256.toUpperCase()) {
      throw new Error("Patch artifact hash or size does not match its receipt");
    }
    const config = JSON.parse(readFileSync(this.workerConfigPath, "utf8"));
    const allowed = new Set((config.writableWorkspacePaths ?? []).map((path: string) => path.replaceAll("\\", "/")));
    if (allowed.size === 0) throw new Error("No authoritative patch paths are approved");
    // Reuse the exact bytes that passed the receipt check. Reopening the path
    // for each Git invocation would let a replaced artifact escape validation.
    const gitApply = (args: string[]) => execFileSync("git", ["-C", this.projectRoot, "apply", ...args, "-"],
      { input: patchBytes, maxBuffer: 128 * 1024 * 1024 });
    const numstat = gitApply(["--numstat", "-z"]).toString("utf8");
    const changed = numstat.split("\0").filter(Boolean).map((line) => line.slice(line.indexOf("\t", line.indexOf("\t") + 1) + 1).replaceAll("\\", "/"));
    if (changed.length !== patch.changedFiles || changed.some((path) =>
      path.split("/").some((part) => part === ".." || part === ".git") ||
      ![...allowed].some((root) => root === "." ? !excludedDevelopmentPath(path) : path === root || path.startsWith(`${root}/`)))) throw new Error("Patch exceeds the approved path set");
    execFileSync("git", ["-C", this.projectRoot, "apply", "--check", "-"], { input: patchBytes, stdio: ["pipe", "pipe", "pipe"] });
    gitApply([]);
  }
}
