/**
 * Isolation-receipt checks shared by every worker CLI that runs inside the
 * Codex MXC sandbox through a contained launch (Claude Code, Grok Build,
 * Cursor). Before a model call, a non-model acceptance harness probes the real
 * sandbox and writes a receipt; dispatch is allowed only if that receipt still
 * matches the exact executable, adapter, harness, workspace, permissions and
 * host security state. Each adapter adds only the checks that are genuinely its
 * own (plan item 2.9, step 2).
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectScope } from "./worker-sandbox.ts";
import { stableWorkspaceChildren } from "./worker-sandbox.ts";

/** The config fields every contained worker shares. */
export type ContainedWorkerConfig = {
  executable: string;
  executableArguments?: string[];
  containmentExecutable: string;
  containmentProfile: string;
  containmentWindowsSandbox: string;
  deniedSourceRoot: string;
  containedAppData: string;
  containedUsername: string;
  containedUserProfile: string;
  userInfoShim: string;
  pathVerifierShim: string;
  configurationDirectory: string;
  runtimeConfigurationRoot: string;
  isolationAcceptanceHarness?: string | null;
};

/** The leading, shared part of a contained worker's permission-envelope fingerprint (key order is part of the hash). */
export function containedEnvelopeCore(config: ContainedWorkerConfig, workspace: string, projectScope: ProjectScope | null,
  launcherArtifacts: Array<{ path: string; sha256: string }>, sha256File: (path: string) => string): Record<string, unknown> {
  return {
    executable: resolve(config.executable),
    executableArguments: config.executableArguments ?? [],
    launcherArtifacts,
    containmentExecutable: resolve(config.containmentExecutable),
    containmentProfile: config.containmentProfile,
    containmentWindowsSandbox: config.containmentWindowsSandbox,
    workspace: resolve(workspace),
    deniedSourceRoot: resolve(config.deniedSourceRoot),
    ...(projectScope ? {
      assignedProjectRoot: projectScope.assignedProjectRoot,
      readableProjectRoots: projectScope.readableProjectRoots,
      deniedParentPaths: projectScope.deniedParentPaths,
      protectedPaths: projectScope.protectedPaths,
    } : {}),
    containedAppData: resolve(config.containedAppData),
    containedUsername: config.containedUsername,
    containedUserProfile: resolve(config.containedUserProfile),
    userInfoShim: resolve(config.userInfoShim),
    pathVerifierShim: resolve(config.pathVerifierShim),
    pathVerifierShimSha256: sha256File(config.pathVerifierShim),
    configurationDirectory: resolve(config.configurationDirectory),
  };
}

/**
 * Paths whose access rules the host security-state fingerprint binds: the
 * workspace and project, the worker's executable (and its folder and launcher
 * files), every scope path, the contained identity, shims, sign-in and runtime
 * folders, the harness, the workspace metadata and receipt folder, and every
 * stable or mutable workspace path. `extraPaths` adds adapter-only files.
 */
export function containedSecurityBoundaryPaths(config: ContainedWorkerConfig, workspace: string, projectScope: ProjectScope | null,
  receiptPath: string, writablePaths: string[], mutableParents: string[], extraPaths: string[] = []): string[] {
  return [
    workspace, config.deniedSourceRoot, config.executable, dirname(config.executable), config.containmentExecutable,
    ...(config.executableArguments ?? []).filter((value) => isAbsolute(value)).flatMap((path) => [path, dirname(path)]),
    ...(projectScope?.deniedParentPaths ?? []), ...(projectScope?.readableProjectRoots ?? []), ...(projectScope?.protectedPaths ?? []),
    config.containedAppData, config.containedUserProfile, config.userInfoShim, config.pathVerifierShim, ...extraPaths,
    config.configurationDirectory, config.runtimeConfigurationRoot, config.isolationAcceptanceHarness ?? "",
    join(workspace, ".git"), join(workspace, ".worker-isolation.json"), dirname(resolve(receiptPath)),
    // Approved output paths and per-job config/runtime children are mutable by
    // design. Their creation-controlling roots stay ACL-bound; unexpected
    // workspace siblings remain stable membership-bound security surfaces.
    ...stableWorkspaceChildren(workspace, writablePaths), ...mutableParents,
  ].filter(Boolean);
}

/** The receipt fields every contained worker's acceptance harness writes. */
export type ContainedWriteReceipt = {
  schemaVersion: number; executableVersion: string; workspace: string; executableSha256: string;
  containmentExecutableSha256: string; adapterSha256: string; acceptanceHarnessPath: string; acceptanceHarnessSha256: string;
  isolationEnvelopeSha256: string; securityStateProbePath: string; securityStateProbeSha256: string;
  securityBoundaryPaths: unknown; mutableBoundaryRoots: unknown; hostSecurityStateFingerprint: string; writableWorkspacePaths: unknown;
  outsideWorkspaceWritesDenied: boolean; unapprovedWorkspaceWritesDenied: boolean; containmentExecutable: string;
  containmentProfile: string; containmentWindowsSandbox: string; containedAppData: string; containedUsername: string;
  containedUserProfile: string; userInfoShim: string; userInfoShimSha256: string; runtimeConfigurationRoot: string;
  runtimeConfigurationWritesRestricted: boolean; runtimeConfigurationWriteProbePassed: boolean; runtimeConfigurationNeighborDenied: boolean;
  registeredProjectReadsAllowed?: boolean; unassignedProjectWritesDenied?: boolean; protectedPathsDenied?: boolean; parentUserDirectoryDenied?: boolean;
};

/**
 * The checks every contained worker's write-isolation receipt must pass:
 * same binaries, adapter and harness; same permission envelope and host
 * security state; the live probes showed writes outside the approved paths,
 * the runtime folder's neighbours and (with a project scope) unassigned
 * projects, protected paths and parent folders all denied.
 */
export function containedWriteReceiptChecks(input: {
  receipt: ContainedWriteReceipt; config: ContainedWorkerConfig; workspace: string; executableVersion: string;
  adapterPath: string; envelopeSha256: string; expectedWritablePaths: string[]; scoped: boolean;
  securityState: { securityStateProbePath: string; securityStateProbeSha256: string; securityBoundaryPaths: unknown;
    mutableBoundaryRoots: unknown; hostSecurityStateFingerprint: string };
  sha256File: (path: string) => string;
}): Array<[string, boolean]> {
  const { receipt, config, securityState, sha256File } = input;
  return [
    ["schema", receipt.schemaVersion === 1], ["executable version", receipt.executableVersion.trim() === input.executableVersion],
    ["workspace", resolve(receipt.workspace) === resolve(input.workspace)], ["executable hash", receipt.executableSha256 === sha256File(config.executable)],
    ["containment hash", receipt.containmentExecutableSha256 === sha256File(config.containmentExecutable)], ["adapter hash", receipt.adapterSha256 === sha256File(input.adapterPath)],
    ["harness path", !!config.isolationAcceptanceHarness && resolve(receipt.acceptanceHarnessPath) === resolve(config.isolationAcceptanceHarness)],
    ["harness hash", !!config.isolationAcceptanceHarness && receipt.acceptanceHarnessSha256 === sha256File(config.isolationAcceptanceHarness)],
    ["permission envelope", receipt.isolationEnvelopeSha256 === input.envelopeSha256],
    ["security probe path", receipt.securityStateProbePath === securityState.securityStateProbePath], ["security probe hash", receipt.securityStateProbeSha256 === securityState.securityStateProbeSha256],
    ["security boundaries", JSON.stringify(receipt.securityBoundaryPaths) === JSON.stringify(securityState.securityBoundaryPaths)],
    ["mutable boundary roots", JSON.stringify(receipt.mutableBoundaryRoots) === JSON.stringify(securityState.mutableBoundaryRoots)],
    ["host security state", receipt.hostSecurityStateFingerprint === securityState.hostSecurityStateFingerprint],
    ["writable paths", JSON.stringify(receipt.writableWorkspacePaths) === JSON.stringify(input.expectedWritablePaths)],
    ["outside write probe", receipt.outsideWorkspaceWritesDenied === true], ["unapproved write probe", receipt.unapprovedWorkspaceWritesDenied === true],
    ["containment executable", resolve(receipt.containmentExecutable) === resolve(config.containmentExecutable)],
    ["containment profile", receipt.containmentProfile === config.containmentProfile], ["containment sandbox", receipt.containmentWindowsSandbox === config.containmentWindowsSandbox],
    ["contained app data", resolve(receipt.containedAppData) === resolve(config.containedAppData)], ["contained user", receipt.containedUsername === config.containedUsername],
    ["contained profile", resolve(receipt.containedUserProfile) === resolve(config.containedUserProfile)], ["user shim", resolve(receipt.userInfoShim) === resolve(config.userInfoShim)],
    ["user shim hash", receipt.userInfoShimSha256 === sha256File(config.userInfoShim)], ["runtime root", resolve(receipt.runtimeConfigurationRoot) === resolve(config.runtimeConfigurationRoot)],
    ["runtime restriction probe", receipt.runtimeConfigurationWritesRestricted === true], ["runtime write probe", receipt.runtimeConfigurationWriteProbePassed === true],
    ["runtime neighbor probe", receipt.runtimeConfigurationNeighborDenied === true],
    ["registered project read probe", !input.scoped || receipt.registeredProjectReadsAllowed === true],
    ["unassigned project write probe", !input.scoped || receipt.unassignedProjectWritesDenied === true],
    ["protected path probe", !input.scoped || receipt.protectedPathsDenied === true],
    ["parent directory probe", !input.scoped || receipt.parentUserDirectoryDenied === true],
  ];
}
