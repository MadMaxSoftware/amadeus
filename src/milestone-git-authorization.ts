import { createHash } from "node:crypto";

export type MilestoneGitAction = "commit" | "push";
export type MilestoneGitDecision = "allow" | "deny";
export type ApprovalConsumption = "available" | "reserved" | "consumed" | "uncertain";

export type GoalGitApproval = {
  schemaVersion: 2;
  approvalId: string;
  goalId: string;
  goalRevision: number;
  sourceRevision: string;
  patchDigest: string;
  changedPathsDigest: string;
  action: MilestoneGitAction;
  decision: MilestoneGitDecision;
  targetBranch?: string | null;
  targetRemote?: string | null;
  targetRemoteUrl?: string | null;
  authorityEventId: string;
  authorityActorId: string;
  authorityChannel: string;
  provenanceVerified: boolean;
  consumption: ApprovalConsumption;
  grantScope?: "single_use" | "bounded_standing";
  parentStandingGrantId?: string | null;
};

export type MilestoneGitAuthorization = {
  goalId: string;
  goalRevision: number;
  sourceRevision: string;
  patchDigest: string;
  changedPathsDigest: string;
  commitAllowed: boolean;
  pushAllowed: boolean;
  targetBranch: string | null;
  targetRemote: string | null;
  targetRemoteUrl: string | null;
  status: "authorized" | "denied" | "conflict";
  reason: string;
  approvalIds: string[];
  grantScope?: "single_use" | "bounded_standing";
  authorizationReference?: string | null;
};

export type StandingMilestoneGitGrant = {
  schemaVersion: 1;
  enabled: boolean;
  grantId: string;
  authorizedAt: string;
  authorizedBy: string;
  provenance: string;
  trigger: "goal_complete";
  automaticCommit: boolean;
  automaticPush: boolean;
  projectRoots: string[];
  allowedBranches: string[];
  allowedBranchPrefixes: string[];
  blockedBranches: string[];
  remote: string;
  remoteUrl: string;
};

export function digestChangedPaths(paths: string[]): string {
  const canonical = [...new Set(paths.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean))].sort();
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function isSha256(value: string): boolean { return /^[a-f0-9]{64}$/i.test(value); }
export function isSafeGitBranchTarget(value: string): boolean {
  return Boolean(value) && !value.startsWith("-") && !value.endsWith(".") && !value.endsWith("/")
    && !value.includes("..") && !value.includes("@{") && !/[\x00-\x20\x7f~^:?*[\\]/.test(value);
}
export function isSafeGitRemoteTarget(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }

function canonicalFsPath(value: string): string { return value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase(); }

function denied(input: { goalId: string; goalRevision: number; sourceRevision: string; patchDigest: string; changedPathsDigest: string }, reason: string,
  status: MilestoneGitAuthorization["status"] = "denied", approvalIds: string[] = []): MilestoneGitAuthorization {
  return { ...input, commitAllowed: false, pushAllowed: false, targetBranch: null, targetRemote: null, targetRemoteUrl: null,
    status, reason, approvalIds };
}

/** Resolve only verified, available, single-use approvals bound to one exact milestone artifact. */
export function resolveMilestoneGitAuthorization(input: {
  goalId: string; goalRevision: number; sourceRevision: string; patchDigest: string; changedPaths: string[];
  approvals?: GoalGitApproval[] | null;
}): MilestoneGitAuthorization {
  const binding = { goalId: input.goalId.trim(), goalRevision: input.goalRevision, sourceRevision: input.sourceRevision.trim(),
    patchDigest: input.patchDigest.toLowerCase(), changedPathsDigest: digestChangedPaths(input.changedPaths) };
  if (!binding.goalId || !binding.sourceRevision || !Number.isSafeInteger(binding.goalRevision) || binding.goalRevision < 1
    || !isSha256(binding.patchDigest)) return denied(binding, "Goal, source or patch authorization binding is invalid.");
  const approvals = input.approvals ?? [];
  if (!Array.isArray(approvals) || !approvals.length) return denied(binding, "No explicit structured Git approval is recorded.");
  const bound = approvals.filter((approval) => approval && approval.goalId === binding.goalId
    && approval.goalRevision === binding.goalRevision && approval.sourceRevision === binding.sourceRevision
    && approval.patchDigest.toLowerCase() === binding.patchDigest && approval.changedPathsDigest === binding.changedPathsDigest);
  if (!bound.length) return denied(binding, "No Git approval matches this exact goal revision, patch and path set.");
  if (bound.some((approval) => approval.schemaVersion !== 2 || !approval.provenanceVerified
    || !approval.authorityEventId?.trim() || !approval.authorityActorId?.trim() || !approval.authorityChannel?.trim())) {
    return denied(binding, "A matching Git approval lacks verified actor/event provenance.");
  }
  if (bound.some((approval) => (approval.grantScope ?? "single_use") !== "single_use")) {
    return denied(binding, "A bounded standing grant must be converted by an authenticated transport into a bound single-use approval.");
  }
  if (bound.some((approval) => approval.consumption !== "available")) {
    return denied(binding, "A matching Git approval was already reserved, consumed, or has an uncertain outcome.");
  }
  if (bound.some((approval) => !approval.approvalId?.trim() || !["commit", "push"].includes(approval.action)
    || !["allow", "deny"].includes(approval.decision))) return denied(binding, "A matching Git approval record is malformed.");
  if (new Set(bound.map((approval) => approval.approvalId)).size !== bound.length) {
    return denied(binding, "Matching Git approval identifiers are not unique.", "conflict");
  }
  const approvalIds = bound.map((approval) => approval.approvalId);
  const byAction = (action: MilestoneGitAction) => bound.filter((approval) => approval.action === action);
  const commit = byAction("commit"); const push = byAction("push");
  const conflicts = (records: GoalGitApproval[]) => new Set(records.map((record) => record.decision)).size > 1;
  if (conflicts(commit) || conflicts(push)) return denied(binding, "Conflicting Git approval decisions were recorded.", "conflict", approvalIds);
  if (!commit.length || commit.some((record) => record.decision !== "allow")) {
    return denied(binding, "Commit is not explicitly approved for this milestone artifact.", "denied", approvalIds);
  }
  const pushAllows = push.filter((record) => record.decision === "allow");
  if (!pushAllows.length || push.some((record) => record.decision === "deny")) {
    return { ...binding, commitAllowed: true, pushAllowed: false, targetBranch: null, targetRemote: null, targetRemoteUrl: null,
      status: "authorized", reason: "Commit is explicitly approved; push is not approved.", approvalIds };
  }
  const branches = new Set(pushAllows.map((record) => record.targetBranch?.trim()).filter(Boolean) as string[]);
  const remotes = new Set(pushAllows.map((record) => record.targetRemote?.trim()).filter(Boolean) as string[]);
  const urls = new Set(pushAllows.map((record) => record.targetRemoteUrl?.trim()).filter(Boolean) as string[]);
  if (branches.size !== 1 || remotes.size !== 1 || urls.size !== 1) {
    return denied(binding, "Push approval has a missing or conflicting branch, remote name, or remote URL.", "conflict", approvalIds);
  }
  const targetBranch = [...branches][0]; const targetRemote = [...remotes][0]; const targetRemoteUrl = [...urls][0];
  if (!isSafeGitBranchTarget(targetBranch) || !isSafeGitRemoteTarget(targetRemote)) {
    return denied(binding, "Push approval target is unsafe.", "conflict", approvalIds);
  }
  return { ...binding, commitAllowed: true, pushAllowed: true, targetBranch, targetRemote, targetRemoteUrl,
    status: "authorized", reason: "Commit and push are approved for the exact milestone artifact and remote URL.", approvalIds,
    grantScope: "single_use", authorizationReference: null };
}

/** Bind the owner's recorded reusable policy to one exact, verified goal-completion artifact. */
export function resolveStandingMilestoneGitAuthorization(input: {
  goalId: string;
  goalRevision: number;
  sourceRevision: string;
  patchDigest: string;
  changedPaths: string[];
  decisionStatus: string;
  projectRoot: string;
  currentBranch: string;
  currentRemoteUrl: string | null;
  grant?: StandingMilestoneGitGrant | null;
}): MilestoneGitAuthorization {
  const binding = { goalId: input.goalId.trim(), goalRevision: input.goalRevision, sourceRevision: input.sourceRevision.trim(),
    patchDigest: input.patchDigest.toLowerCase(), changedPathsDigest: digestChangedPaths(input.changedPaths) };
  if (!binding.goalId || !binding.sourceRevision || !Number.isSafeInteger(binding.goalRevision) || binding.goalRevision < 1
    || !isSha256(binding.patchDigest)) return denied(binding, "Goal, source or patch authorization binding is invalid.");
  const grant = input.grant;
  if (!grant?.enabled || grant.schemaVersion !== 1 || grant.trigger !== "goal_complete") {
    return denied(binding, "No enabled goal-completion standing Git grant is configured.");
  }
  if (input.decisionStatus !== "complete") return denied(binding, "Standing Git authorization applies only after verified goal completion.");
  if (!grant.grantId?.trim() || !grant.authorizedAt?.trim() || !grant.authorizedBy?.trim() || !grant.provenance?.trim()) {
    return denied(binding, "Standing Git authorization lacks recorded owner provenance.");
  }
  if (!grant.automaticCommit) return denied(binding, "Standing Git authorization does not allow automatic commit.");
  if (!Array.isArray(grant.projectRoots) || !grant.projectRoots.map(canonicalFsPath).includes(canonicalFsPath(input.projectRoot))) {
    return denied(binding, "Project root is outside the standing Git authorization.");
  }
  const branch = input.currentBranch.trim();
  if (!isSafeGitBranchTarget(branch)) return denied(binding, "Current Git branch is missing or unsafe.");
  const blocked = new Set((grant.blockedBranches ?? []).map((value) => value.toLowerCase()));
  const allowedExact = (grant.allowedBranches ?? []).some((value) => value.toLowerCase() === branch.toLowerCase());
  const allowedPrefix = (grant.allowedBranchPrefixes ?? []).some((value) => value && branch.toLowerCase().startsWith(value.toLowerCase()));
  if (blocked.has(branch.toLowerCase()) || (!allowedExact && !allowedPrefix)) {
    return denied(binding, `Branch ${branch} is outside the standing Git authorization.`);
  }
  if (!grant.automaticPush) {
    return { ...binding, commitAllowed: true, pushAllowed: false, targetBranch: null, targetRemote: null, targetRemoteUrl: null,
      status: "authorized", reason: "Goal-completion standing authorization allows a scoped commit but not push.",
      approvalIds: [grant.grantId], grantScope: "bounded_standing", authorizationReference: grant.provenance };
  }
  if (!isSafeGitRemoteTarget(grant.remote) || !grant.remoteUrl?.trim() || input.currentRemoteUrl !== grant.remoteUrl) {
    return denied(binding, "Configured Git remote does not match the standing authorization.");
  }
  return { ...binding, commitAllowed: true, pushAllowed: true, targetBranch: branch, targetRemote: grant.remote,
    targetRemoteUrl: grant.remoteUrl, status: "authorized",
    reason: "Verified goal completion is covered by the recorded standing milestone authorization.",
    approvalIds: [grant.grantId], grantScope: "bounded_standing", authorizationReference: grant.provenance };
}
