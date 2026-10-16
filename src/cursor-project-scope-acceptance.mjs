// Non-model Windows containment acceptance for a project-scoped Cursor worker.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCursorContainmentLaunch,
  buildCursorImplementationPlan,
  buildCursorEnvironment,
  cursorIsolationEnvelopeSha256,
  cursorIsolationSecurityState,
} from "./cursor-adapter.ts";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function isWithin(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function firstProjectProbe(projectRoot) {
  for (const name of ["README.md", "package.json", "AGENTS.md"]) {
    const path = join(projectRoot, name);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  throw new Error("Assigned project has no supported non-sensitive acceptance probe (README.md, package.json, or AGENTS.md)");
}

function cursorVersion(config) {
  const result = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false, env: buildCursorEnvironment(config), timeout: 15_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("Cursor executable version could not be verified");
  return result.stdout.trim();
}

const adapter = arg("-Adapter");
if (adapter !== "cursor") throw new Error("This acceptance harness is for Cursor only");
const workspace = resolve(arg("-Workspace"));
const configPath = resolve(arg("-ConfigPath"));
const receiptPath = resolve(arg("-ReceiptPath"));
const config = JSON.parse(readFileSync(configPath, "utf8"));

if (!isAbsolute(config.assignedProjectRoot) || !existsSync(config.assignedProjectRoot)) throw new Error("Cursor acceptance requires an existing assigned project root");
if (!Array.isArray(config.readableProjectRoots) || !config.readableProjectRoots.some((root) => isWithin(root, config.assignedProjectRoot))) {
  throw new Error("Assigned project is not inside a reviewed readable project root");
}
if (!Array.isArray(config.protectedPaths) || config.protectedPaths.length === 0) throw new Error("Protected paths are required");
if (config.enabled !== false || config.dispatchAuthorized !== false || config.implementationDispatchAuthorized !== false || config.automaticStartup !== false) {
  throw new Error("Persistent Cursor dispatch guards must remain disabled during acceptance");
}

const writablePaths = Array.isArray(config.writableWorkspacePaths) ? config.writableWorkspacePaths : [];
const token = createHash("sha256").update(`${process.pid}:${Date.now()}:${workspace}`).digest("hex").slice(0, 24);
const runtimeDirectory = join(resolve(config.runtimeConfigurationRoot), `project-scope-${token}`);
const runtimePath = join(runtimeDirectory, "runtime.tmp");
const runtimeNeighbor = join(resolve(config.runtimeConfigurationRoot), `neighbor-${token}.tmp`);
// Derive and validate the containment launch while the isolated repository is
// still pristine. The probe fixtures below are intentionally untracked files;
// creating them before assertSafeConfig/verifyWorkspace would make every
// writable acceptance fail with "Worker repository is not clean" before the
// containment process could start.
const plan = buildCursorImplementationPlan(config, workspace, "non-model project-scope acceptance");
const launch = buildCursorContainmentLaunch(config, workspace, plan.args, writablePaths, runtimeDirectory);
mkdirSync(runtimeDirectory, { recursive: false });

const rootWritable = writablePaths.includes(".");
let approvedPath = null;
if (writablePaths.length > 0) {
  approvedPath = rootWritable
    ? join(workspace, `.amadeus-isolation-allowed-${token}.tmp`)
    : resolve(workspace, writablePaths[0]);
  if (!isWithin(workspace, approvedPath)) throw new Error("Configured writable path escapes the worker workspace");
  if (existsSync(approvedPath) && statSync(approvedPath).isDirectory()) approvedPath = join(approvedPath, `.amadeus-isolation-allowed-${token}.tmp`);
}
const approvedExisted = approvedPath ? existsSync(approvedPath) : false;
const approvedBefore = approvedExisted ? readFileSync(approvedPath) : null;
if (approvedPath && !approvedExisted) writeFileSync(approvedPath, "", { flag: "wx" });
const unapprovedPath = rootWritable ? null : join(workspace, `.amadeus-isolation-denied-${token}.tmp`);
if (unapprovedPath) writeFileSync(unapprovedPath, "deny", { flag: "wx" });

const workspaceReceipt = join(workspace, ".worker-isolation.json");
const gitHead = join(workspace, ".git", "HEAD");
for (const required of [workspaceReceipt, gitHead]) {
  if (!existsSync(required)) throw new Error(`Missing acceptance fixture: ${required}`);
}
const readProbe = firstProjectProbe(resolve(config.assignedProjectRoot));
const protectedRoot = config.protectedPaths.find((path) => isWithin(path, dirname(receiptPath)));
if (!protectedRoot) throw new Error("Isolation receipt directory must be inside a configured protected path");
const protectedSentinel = join(dirname(receiptPath), `.amadeus-protected-${token}.txt`);
writeFileSync(protectedSentinel, `protected-${token}`, { flag: "wx" });
const outsideAccountDirectory = config.deniedParentPaths.find((path) => existsSync(path) && statSync(path).isDirectory());
if (!outsideAccountDirectory) throw new Error("At least one existing denied parent directory is required");

const before = {
  approved: approvedExisted ? sha256File(approvedPath) : null,
  workspaceReceipt: sha256File(workspaceReceipt),
};
const payload = Buffer.from(JSON.stringify({
  readProbe, readProbeHash: sha256File(readProbe), approvedPath, unapprovedPath, protectedSentinel,
  outsideAccountDirectory, gitHead, workspaceReceipt, runtimePath, runtimeNeighbor,
}), "utf8").toString("base64");
const probe = String.raw`
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$readSucceeded = (Get-FileHash -Algorithm SHA256 -LiteralPath ([string]$p.readProbe)).Hash -eq [string]$p.readProbeHash
$assignedWriteSucceeded = $true
if ($p.approvedPath) { Set-Content -LiteralPath ([string]$p.approvedPath) -Value 'assigned-workspace-write'; $assignedWriteSucceeded = ((Get-Content -Raw -LiteralPath ([string]$p.approvedPath)).Trim() -eq 'assigned-workspace-write') }
$unapprovedDenied = $true
if ($p.unapprovedPath) { $unapprovedDenied = $false; try { Set-Content -LiteralPath ([string]$p.unapprovedPath) -Value 'escape' } catch { $unapprovedDenied = $true } }
$sourceWriteDenied = $false
$stream = $null
try { $stream = [IO.File]::Open([string]$p.readProbe, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite) } catch { $sourceWriteDenied = $true } finally { if ($stream) { $stream.Dispose() } }
$protectedDenied = $false
try { Get-Content -Raw -LiteralPath ([string]$p.protectedSentinel) | Out-Null } catch { $protectedDenied = $true }
$parentDenied = $false
try { Get-ChildItem -LiteralPath ([string]$p.outsideAccountDirectory) -Force | Out-Null } catch { $parentDenied = $true }
$gitReadSucceeded = $true
try { Get-Content -Raw -LiteralPath ([string]$p.gitHead) | Out-Null } catch { $gitReadSucceeded = $false }
$receiptReadSucceeded = $true
try { Get-Content -Raw -LiteralPath ([string]$p.workspaceReceipt) | Out-Null } catch { $receiptReadSucceeded = $false }
$gitWriteDenied = $false
$stream = $null
try { $stream = [IO.File]::Open([string]$p.gitHead, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite) } catch { $gitWriteDenied = $true } finally { if ($stream) { $stream.Dispose() } }
$receiptWriteDenied = $false
$stream = $null
try { $stream = [IO.File]::Open([string]$p.workspaceReceipt, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite) } catch { $receiptWriteDenied = $true } finally { if ($stream) { $stream.Dispose() } }
$runtimeWriteSucceeded = $true
$runtimeWriteError = $null
$runtimeNeighborDenied = $true
try { Set-Content -LiteralPath ([string]$p.runtimePath) -Value 'runtime' } catch { $runtimeWriteSucceeded = $false; $runtimeWriteError = $_.Exception.Message }
try { Set-Content -LiteralPath ([string]$p.runtimeNeighbor) -Value 'escape'; $runtimeNeighborDenied = $false } catch {}
[ordered]@{ registeredReadsSucceeded=$readSucceeded; assignedWorkspaceWriteSucceeded=$assignedWriteSucceeded; unapprovedWorkspaceWriteDenied=$unapprovedDenied; registeredRootWritesDenied=$sourceWriteDenied; protectedPathDenied=$protectedDenied; parentPathDenied=$parentDenied; gitHistoryReadSucceeded=$gitReadSucceeded; isolationReceiptReadSucceeded=$receiptReadSucceeded; gitHistoryDenied=$gitWriteDenied; isolationReceiptDenied=$receiptWriteDenied; runtimeWriteSucceeded=$runtimeWriteSucceeded; runtimeWriteError=$runtimeWriteError; runtimeNeighborDenied=$runtimeNeighborDenied } | ConvertTo-Json -Compress
`;

let result;
let execution;
try {
  const separator = launch.args.lastIndexOf("--");
  if (separator < 0) throw new Error("Cursor containment launch has no command separator");
  const encoded = Buffer.from(probe, "utf16le").toString("base64");
  execution = spawnSync(launch.executable, [...launch.args.slice(0, separator + 1), "pwsh", "-NoProfile", "-EncodedCommand", encoded], {
    cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  const lines = `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`.split(/\r?\n/).filter(Boolean);
  const json = [...lines].reverse().find((line) => line.trim().startsWith("{"));
  if (!json) throw new Error(`Containment probe returned no JSON result: ${lines.join(" | ")}`);
  result = JSON.parse(json);
} finally {
  if (approvedPath) {
    if (approvedExisted) writeFileSync(approvedPath, approvedBefore);
    else rmSync(approvedPath, { force: true });
  }
  if (unapprovedPath) rmSync(unapprovedPath, { force: true });
  rmSync(protectedSentinel, { force: true });
  rmSync(runtimeNeighbor, { force: true });
  rmSync(runtimeDirectory, { recursive: true, force: true });
}

const after = { approved: approvedExisted ? sha256File(approvedPath) : null, workspaceReceipt: sha256File(workspaceReceipt) };
const workspaceRestored = before.approved === after.approved && before.workspaceReceipt === after.workspaceReceipt && (!unapprovedPath || !existsSync(unapprovedPath));
const passed = execution?.status === 0 && !execution.error && [
  result.registeredReadsSucceeded, result.assignedWorkspaceWriteSucceeded,
  result.unapprovedWorkspaceWriteDenied, result.registeredRootWritesDenied,
  result.protectedPathDenied, result.parentPathDenied, result.gitHistoryReadSucceeded,
  result.isolationReceiptReadSucceeded, result.gitHistoryDenied, result.isolationReceiptDenied,
  result.runtimeWriteSucceeded, result.runtimeNeighborDenied,
].every((value) => value === true) && workspaceRestored;
const attempt = { adapter, testedAt: new Date().toISOString(), modelInvoked: false, timedOut: execution?.error?.code === "ETIMEDOUT", exitCode: execution?.status ?? null, result, workspaceRestored, passed };
console.log(JSON.stringify(attempt));
if (!passed) throw new Error("Project-scope host acceptance failed for Cursor");

const security = cursorIsolationSecurityState(config, workspace, receiptPath);
const cursorAdapterPath = fileURLToPath(new URL("./cursor-adapter.ts", import.meta.url));
const receipt = {
  schemaVersion: 1,
  executableVersion: cursorVersion(config),
  executableSha256: sha256File(config.executable),
  containmentExecutableSha256: sha256File(config.containmentExecutable),
  adapterSha256: sha256File(cursorAdapterPath),
  acceptanceHarnessPath: fileURLToPath(import.meta.url),
  acceptanceHarnessSha256: sha256File(fileURLToPath(import.meta.url)),
  isolationEnvelopeSha256: cursorIsolationEnvelopeSha256(config, workspace),
  ...security,
  workspace,
  authoritativeRepositoryDenied: false,
  registeredProjectReadsAllowed: true,
  unassignedProjectWritesDenied: true,
  protectedPathsDenied: true,
  parentUserDirectoryDenied: true,
  writableWorkspacePaths: writablePaths,
  outsideWorkspaceWritesDenied: true,
  unapprovedWorkspaceWritesDenied: true,
  gitHistoryDenied: true,
  isolationReceiptDenied: true,
  containmentExecutable: config.containmentExecutable,
  containmentProfile: config.containmentProfile,
  containmentWindowsSandbox: config.containmentWindowsSandbox,
  containedAppData: config.containedAppData,
  containedUsername: config.containedUsername,
  containedUserProfile: config.containedUserProfile,
  userInfoShim: config.userInfoShim,
  userInfoShimSha256: sha256File(config.userInfoShim),
  cursorSandboxMode: config.sandbox,
  runtimeConfigurationRoot: config.runtimeConfigurationRoot,
  runtimeConfigurationWritesRestricted: true,
  runtimeConfigurationWriteProbePassed: true,
  runtimeConfigurationNeighborDenied: true,
  testedAt: new Date().toISOString(),
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify(receipt));
