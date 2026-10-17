import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { PatchArtifact } from "./orchestrator.ts";
import { excludedDevelopmentPath } from "./development-project.ts";
import { SEED_RECORD, workingDiffSha256 } from "./worker-isolation.ts";

type TextLine = { text: string; eol: string };

// Worker diffs can legitimately exceed Node's 1 MiB child-process default.
// Keep Git capture bounded, but large enough for normal repository milestones.
const GIT_CAPTURE_MAX_BUFFER = 128 * 1024 * 1024;

function runGit(workspace: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", `safe.directory=${workspace}`, "-C", workspace, ...args], {
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: GIT_CAPTURE_MAX_BUFFER,
    input,
  });
}

function textLines(value: string): TextLine[] {
  return (value.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).filter(Boolean).map((raw) => {
    const match = raw.match(/(\r\n|\r|\n)$/);
    const eol = match?.[1] ?? "";
    return { text: eol ? raw.slice(0, -eol.length) : raw, eol };
  });
}

function normalizedText(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\n");
}

function restoreCommittedLineEndings(head: string, current: string, semanticDiff: string): string | null {
  if (head.includes("\0") || current.includes("\0")) return null;
  const headLines = textLines(head);
  const currentLines = textLines(current);
  const eolCounts = new Map<string, number>();
  for (const line of headLines) if (line.eol) eolCounts.set(line.eol, (eolCounts.get(line.eol) ?? 0) + 1);
  const dominantEol = [...eolCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "\n";
  const hunks = [...semanticDiff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]), newCount: Number(match[4] ?? 1),
  }));
  if (!hunks.length) return normalizedText(head) === normalizedText(current) ? head : null;
  const rebuilt = [...headLines];
  for (const hunk of hunks.reverse()) {
    const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    const replaced = rebuilt.slice(oldIndex, oldIndex + hunk.oldCount);
    const beforeEol = rebuilt[oldIndex - 1]?.eol;
    const afterEol = rebuilt[oldIndex + hunk.oldCount]?.eol;
    const additions = currentLines.slice(newIndex, newIndex + hunk.newCount).map((line, index) => ({
      text: line.text,
      eol: line.eol === "" && newIndex + index === currentLines.length - 1 ? ""
        : replaced[index]?.eol || beforeEol || afterEol || dominantEol,
    }));
    rebuilt.splice(oldIndex, hunk.oldCount, ...additions);
  }
  const result = rebuilt.map((line) => `${line.text}${line.eol}`).join("");
  return normalizedText(result) === normalizedText(current) ? result : null;
}

export function normalizeTrackedLineEndings(workspace: string, trackedPaths: string[]): void {
  const git = (args: string[]) => runGit(workspace, args);
  for (const path of trackedPaths) {
    const head = git(["show", `HEAD:${path}`]);
    const currentPath = join(workspace, ...path.split("/"));
    const current = readFileSync(currentPath, "utf8");
    const semanticDiff = git(["diff", "HEAD", "--ignore-space-at-eol", "--unified=0", "--no-ext-diff", "--", path]);
    const normalized = restoreCommittedLineEndings(head, current, semanticDiff);
    if (normalized !== null && normalized !== current) writeFileSync(currentPath, normalized, "utf8");
  }
}

/** Collect tracked edits and new files on the host, without giving workers Git access. */
export function captureWorkerPatch(workspace: string, allowedPaths: string[], artifactRoot: string, workspaceId: string): PatchArtifact | undefined {
  const git = (args: string[]) => runGit(workspace, args);
  const allowed = (path: string) => allowedPaths.some((root) => root === "." ? !excludedDevelopmentPath(path) : path === root || path.startsWith(`${root}/`));
  const headPaths = new Set(git(["ls-tree", "-r", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean));
  const initialTracked = git(["diff", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean);
  const excludedIntentToAdd = initialTracked.filter((path) => excludedDevelopmentPath(path) && !headPaths.has(path));
  if (excludedIntentToAdd.length) {
    runGit(workspace, ["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"], `${excludedIntentToAdd.join("\0")}\0`);
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
    .filter((path) => !excludedDevelopmentPath(path));
  const tracked = git(["diff", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean);
  const modifiedTracked = git(["diff", "HEAD", "--name-only", "--diff-filter=M", "-z"]).split("\0").filter(Boolean);
  if ([...untracked, ...tracked].some((path) => !allowed(path) || /(^|\/)\.git(\/|$)/i.test(path) || path === ".worker-isolation.json")) {
    throw new Error("Worker changes exceeded the approved workspace paths");
  }
  // Editors can rewrite an entire tracked text file with another newline
  // convention. Rebuild substantive hunks over the exact committed line
  // endings before patch measurement so formatting-only churn cannot obscure
  // valid work or consume a second model attempt. Binary or unsafe cases remain
  // untouched and are still protected by the downstream churn rejection.
  // A prior interrupted capture may have left new files marked intent-to-add.
  // They appear in the HEAD diff but have no HEAD blob, so only normalize
  // files that are genuinely modified relative to the checkpoint.
  normalizeTrackedLineEndings(workspace, modifiedTracked);
  for (const path of untracked) git(["add", "--intent-to-add", "--", path]);
  const patch = git(["diff", "HEAD", "--binary", "--no-ext-diff", "--no-renames"]);
  if (!patch) return undefined;
  const numstat = git(["diff", "HEAD", "--numstat", "-z", "--no-renames"]).split("\0").filter(Boolean);
  const changedLines = numstat.reduce((sum, line) => {
    const [added, removed] = line.split("\t");
    return sum + (added === "-" ? 0 : Number(added)) + (removed === "-" ? 0 : Number(removed));
  }, 0);
  const semanticNumstat = git(["diff", "HEAD", "--ignore-space-at-eol", "--numstat", "-z", "--no-renames"]).split("\0").filter(Boolean);
  const semanticChangedLines = semanticNumstat.reduce((sum, line) => {
    const [added, removed] = line.split("\t");
    return sum + (added === "-" ? 0 : Number(added)) + (removed === "-" ? 0 : Number(removed));
  }, 0);
  const lineEndingOnlyLines = Math.max(0, changedLines - semanticChangedLines);
  mkdirSync(artifactRoot, { recursive: true });
  const path = resolve(join(artifactRoot, `${workspaceId}.patch`));
  writeFileSync(path, patch, "utf8");
  return { path, sha256: createHash("sha256").update(patch).digest("hex").toUpperCase(), bytes: Buffer.byteLength(patch),
    changedFiles: numstat.length, changedLines, semanticChangedLines, lineEndingOnlyLines,
    changedPaths: [...new Set([...tracked, ...untracked])].sort() };
}

/**
 * Start a recovery workspace from the previous attempt's rejected patch, so the recovery
 * worker repairs it instead of redoing it. The patch must match its recorded hash, apply
 * cleanly to the fresh copy and reproduce itself exactly; otherwise the workspace stays a
 * fresh copy. Returns guidance for the worker either way.
 */
export function seedWorkspaceWithPatch(workspace: string, seed: { path: string; sha256: string }): { seeded: boolean; guidance: string } {
  const fresh = { seeded: false, guidance: "\n\nRecovery note: the previous attempt's change could not be applied to this workspace, so it is a fresh copy of the project. Redo that change first, then correct the failure." };
  if (!existsSync(seed.path)) return fresh;
  const patch = readFileSync(seed.path, "utf8");
  if (createHash("sha256").update(patch).digest("hex").toUpperCase() !== seed.sha256.toUpperCase()) return fresh;
  try {
    // Write the patch bytes as captured, whatever the machine's line-ending conversion settings.
    runGit(workspace, ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "--binary", "-"], patch);
    const untracked = runGit(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
      .filter((path) => !excludedDevelopmentPath(path));
    for (const path of untracked) runGit(workspace, ["add", "--intent-to-add", "--", path]);
    if (workingDiffSha256(workspace) !== seed.sha256.toUpperCase()) throw new Error("seeded workspace does not reproduce the patch");
    writeFileSync(join(workspace, ".git", SEED_RECORD), JSON.stringify({ schemaVersion: 1, sha256: seed.sha256.toUpperCase() }));
    return { seeded: true, guidance: "\n\nRecovery note: this workspace already contains the previous attempt's change (it was rejected by verification, not lost). Build on it: do not redo it." };
  } catch {
    runGit(workspace, ["reset", "-q", "--hard", "HEAD"]);
    runGit(workspace, ["clean", "-q", "-f", "-d"]);
    return fresh;
  }
}
