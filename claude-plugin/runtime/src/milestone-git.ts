import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { digestChangedPaths, type MilestoneGitAuthorization } from "./milestone-git-authorization.ts";

export type MilestoneGitPushOutcome = "pushed" | "failed" | "uncertain" | "no_remote" | "not_attempted";

export type MilestoneGitResult = {
  status: "committed_and_pushed" | "committed_not_pushed" | "uncertain" | "skipped" | "failed";
  branch: string | null;
  commit: string | null;
  commitMessage: string | null;
  remote: string | null;
  pushOutcome: MilestoneGitPushOutcome;
  reason: string;
  brief: string;
};

function emptyResult(
  status: MilestoneGitResult["status"],
  reason: string,
  partial: Partial<MilestoneGitResult> = {},
): MilestoneGitResult {
  const result: MilestoneGitResult = {
    status,
    branch: partial.branch ?? null,
    commit: partial.commit ?? null,
    commitMessage: partial.commitMessage ?? null,
    remote: partial.remote ?? null,
    pushOutcome: partial.pushOutcome ?? "not_attempted",
    reason,
    brief: "",
  };
  result.brief = formatMilestoneGitBrief(result);
  return result;
}

export function formatMilestoneGitBrief(result: MilestoneGitResult): string {
  const message = result.commitMessage ?? "(none)";
  const sha = result.commit ?? "(none)";
  const branch = result.branch ?? "(none)";
  const remote = result.remote ?? "(none)";
  const push = result.pushOutcome;
  return [
    `status=${result.status}`,
    `commitMessage=${message}`,
    `sha=${sha}`,
    `branch=${branch}`,
    `remote=${remote}`,
    `push=${push}`,
    `detail=${result.reason}`,
  ].join("; ");
}

/** Map a recorded Git result for owner audits: skipped/failed never count as pass. */
export function gitMilestoneCheckStatus(
  result: Pick<MilestoneGitResult, "status" | "reason"> | null | undefined,
): "pass" | "partial" | "fail" | "not_exercised" {
  if (!result) return "not_exercised";
  if (result.status === "committed_and_pushed") return "pass";
  if (result.status === "committed_not_pushed") return "partial";
  if (result.status === "skipped") {
    return /no Git changes|no staged changes|no verified milestone paths/i.test(result.reason)
      ? "partial"
      : "fail";
  }
  return "fail";
}

export type MilestoneGitRunner = (projectRoot: string, args: string[], raw?: boolean) => string;

const defaultGitRunner: MilestoneGitRunner = (projectRoot, args, raw = false) => {
  const output = execFileSync("git", ["-c", `safe.directory=${projectRoot}`, "-C", projectRoot, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
  return raw ? output : output.trim();
};

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^"|"$/g, "");
}

export function isEmbeddedEvidencePatch(path: string): boolean {
  return /(^|\/)docs\/project-state\/evidence\/patches\/.*\.(?:diff|patch)$/i.test(normalizeRepoPath(path));
}

/** Parse `git status --porcelain=v1` paths, including rename arrow forms. */
export function porcelainPaths(statusText: string): string[] {
  const paths: string[] = [];
  for (const line of statusText.split(/\r?\n/).filter(Boolean)) {
    const body = line.slice(3);
    const arrow = body.includes(" -> ") ? body.split(" -> ").pop()! : body;
    const normalized = normalizeRepoPath(arrow.trim());
    if (normalized) paths.push(normalized);
  }
  return [...new Set(paths)];
}

export function listDirtyPaths(projectRoot: string): string[] {
  try {
    const repo = containingRepo(projectRoot, defaultGitRunner);
    if (!repo) return [];
    const prefix = projectPrefix(repo, projectRoot);
    return porcelainPaths(defaultGitRunner(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--", prefix || "."], true))
      .filter((path) => !prefix || path.startsWith(`${prefix}/`))
      .map((path) => prefix ? path.slice(prefix.length + 1) : path);
  } catch {
    return [];
  }
}

function containingRepo(projectRoot: string, runner: MilestoneGitRunner): string | null {
  // Discovery needs the containing root before safe.directory can be scoped to it.
  const found = runner(projectRoot, ["rev-parse", "--show-toplevel"]);
  const repo = resolve(found);
  const rel = relative(repo, resolve(projectRoot));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  runner(repo, ["rev-parse", "--is-inside-work-tree"]);
  return repo;
}

function projectPrefix(repo: string, projectRoot: string): string {
  return relative(repo, resolve(projectRoot)).split(sep).join("/");
}

/** Commit and push only a verified, coherent milestone; never partial work. */
export function commitVerifiedMilestone(input: {
  projectRoot: string;
  summary: string;
  goalId: string;
  goalRevision: number;
  sourceRevision: string;
  patchDigest: string;
  authorization: MilestoneGitAuthorization;
  changedPaths?: string[];
  /** Paths already dirty before apply; only verified changedPaths may be committed. */
  preDirtyPaths?: string[];
  /** Test seam for proving fail-closed behavior without invoking real Git. */
  gitRunner?: MilestoneGitRunner;
  /** Atomically reserves all single-use approvals before the first mutation. */
  reserveAuthorization?: (approvalIds: string[]) => boolean;
}): MilestoneGitResult {
  const runner = input.gitRunner ?? defaultGitRunner;
  const authorization = input.authorization;
  if (authorization.status !== "authorized" || !authorization.commitAllowed) {
    return emptyResult("failed", `Milestone Git authorization denied: ${authorization.reason}`);
  }
  if (authorization.goalId !== input.goalId
    || authorization.goalRevision !== input.goalRevision
    || authorization.sourceRevision !== input.sourceRevision
    || authorization.patchDigest !== input.patchDigest.toLowerCase()) {
    return emptyResult("failed", "Milestone Git authorization does not match the exact goal, revisions and patch digest.");
  }
  let root: string;
  try {
    const found = containingRepo(input.projectRoot, runner);
    if (!found) return emptyResult("skipped", "Project is not a Git repository.");
    root = found;
  } catch {
    return emptyResult("skipped", "Project is not a Git repository.");
  }
  const branch = runner(root, ["branch", "--show-current"]);
  if (!branch) {
    return emptyResult("skipped", "Repository is detached; no automatic milestone push.", { branch: null });
  }
  const prefix = projectPrefix(root, input.projectRoot);
  const paths = [...new Set((input.changedPaths ?? []).map(normalizeRepoPath))]
    .filter((path) => path && !path.startsWith("/") && !path.includes(":")
      && !path.split("/").some((part) => part === ".." || part === ".git"))
    .map((path) => prefix ? `${prefix}/${path}` : path);
  if (authorization.changedPathsDigest !== digestChangedPaths(input.changedPaths ?? [])) {
    return emptyResult("failed", "Milestone Git authorization does not match the exact changed-path set.", { branch });
  }
  const whitespacePaths = paths.filter((path) => !isEmbeddedEvidencePatch(path));
  if (!paths.length) {
    return emptyResult("skipped", "No verified milestone paths were supplied; unrelated changes were left untouched.", { branch });
  }
  if (authorization.pushAllowed && authorization.targetBranch !== branch) {
    return emptyResult("failed", `Push authorization targets branch ${authorization.targetBranch ?? "(none)"}, not current branch ${branch}.`, { branch });
  }
  let authorizedRemoteUrl: string | null = null;
  if (authorization.pushAllowed) {
    try {
      authorizedRemoteUrl = runner(root, ["remote", "get-url", authorization.targetRemote!]);
    } catch {
      return emptyResult("failed", `Push authorization targets remote ${authorization.targetRemote ?? "(none)"}, which is not configured.`, { branch });
    }
    if (authorizedRemoteUrl !== authorization.targetRemoteUrl) {
      return emptyResult("failed", `Configured remote URL does not match the approved URL for ${authorization.targetRemote}.`, { branch });
    }
  }
  const preDirty = new Set((input.preDirtyPaths ?? []).map(normalizeRepoPath).filter(Boolean)
    .map((path) => prefix ? `${prefix}/${path}` : path));
  try {
    try {
      const whitespace = whitespacePaths.length ? runner(root, ["diff", "--check", "--", ...whitespacePaths]) : "";
      if (whitespace) {
        return emptyResult("failed", "Git whitespace check failed; milestone was not committed.", { branch });
      }
    } catch (error) {
      return emptyResult("failed", `Git whitespace check failed; milestone was not committed: ${error instanceof Error ? error.message : String(error)}`, { branch });
    }
    const dirty = porcelainPaths(runner(root, ["status", "--porcelain=v1", "--untracked-files=all"], true));
    const inScopeDirty = dirty.filter((path) => paths.includes(path));
    const outside = dirty.filter((path) => !paths.includes(path));
    // Pre-dirty in-scope paths are only committed after a successful authoritative apply
    // replaced them with verified content. Unrelated dirty paths stay unstaged.
    const unexpectedOutside = outside.filter((path) => (!prefix || path.startsWith(`${prefix}/`)) && !preDirty.has(path));
    if (unexpectedOutside.length) {
      return emptyResult("failed", `Milestone path set is incomplete; newly dirty dependent paths were not verified: ${unexpectedOutside.join(", ")}.`, { branch });
    }
    const preservedOutside = outside.filter((path) => !unexpectedOutside.includes(path));
    if (!inScopeDirty.length) {
      return emptyResult("skipped", preservedOutside.length
        ? "Verified milestone produced no Git changes on its scoped paths; unrelated dirty paths were preserved."
        : "Verified milestone produced no Git changes.", { branch });
    }
    if (authorization.grantScope !== "bounded_standing"
      && (!input.reserveAuthorization || !input.reserveAuthorization(authorization.approvalIds))) {
      return emptyResult("failed", "Single-use Git approval could not be atomically reserved; possible replay or uncertain prior attempt.", { branch });
    }
    runner(root, ["add", "--", ...paths]);
    try {
      runner(root, ["diff", "--cached", "--quiet"]);
      return emptyResult("skipped", "Milestone paths produced no staged changes.", { branch });
    } catch { /* exit 1 means staged changes exist */ }
    try {
      const cachedWhitespace = whitespacePaths.length ? runner(root, ["diff", "--cached", "--check", "--", ...whitespacePaths]) : "";
      if (cachedWhitespace) {
        runner(root, ["reset", "HEAD", "--", ...paths]);
        return emptyResult("failed", "Git whitespace check failed on staged milestone paths; milestone was not committed.", { branch });
      }
    } catch (error) {
      try { runner(root, ["reset", "HEAD", "--", ...paths]); } catch { /* best-effort unstage */ }
      return emptyResult("failed", `Git whitespace check failed on staged milestone paths: ${error instanceof Error ? error.message : String(error)}`, { branch });
    }
    const message = `Milestone: ${input.summary.replace(/\s+/g, " ").trim().slice(0, 160) || "verified project progress"}`;
    try {
      runner(root, ["commit", "--only", "-m", message, "--", ...paths]);
    } catch (error) {
      return emptyResult("uncertain", `Commit command returned no trustworthy outcome: ${error instanceof Error ? error.message : String(error)}`, {
        branch, commitMessage: message, pushOutcome: "uncertain",
      });
    }
    const commit = runner(root, ["rev-parse", "HEAD"]);
    const preservedNote = outside.length
      ? ` Unrelated dirty paths were preserved (${outside.join(", ")}).`
      : "";
    if (!authorization.pushAllowed) {
      return emptyResult("committed_not_pushed", `Milestone committed locally; push has no matching structured approval.${preservedNote}`, {
        branch, commit, commitMessage: message, remote: null, pushOutcome: "not_attempted",
      });
    }
    const remoteName = authorization.targetRemote!;
    const remote = authorizedRemoteUrl!;
    try {
      runner(root, ["push", remoteName, `HEAD:refs/heads/${branch}`]);
      return emptyResult("committed_and_pushed", `Verified milestone committed and pushed to ${remoteName}.${preservedNote}`, {
        branch, commit, commitMessage: message, remote, pushOutcome: "pushed",
      });
    } catch (error) {
      return emptyResult("uncertain", `Milestone committed, but the push outcome is uncertain: ${error instanceof Error ? error.message : String(error)}${preservedNote}`, {
        branch, commit, commitMessage: message, remote, pushOutcome: "uncertain",
      });
    }
  } catch (error) {
    return emptyResult("failed", error instanceof Error ? error.message : String(error), { branch });
  }
}
