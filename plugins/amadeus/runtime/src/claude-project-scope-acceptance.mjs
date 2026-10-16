// Non-model Windows containment acceptance for a signed-in Claude worker.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClaudeContainmentLaunch,
  buildClaudeImplementationPlan,
  buildClaudeEnvironment,
  claudeIsolationEnvelopeSha256,
  claudeIsolationSecurityState,
} from "./claude-adapter.ts";

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
  throw new Error(`No supported non-sensitive acceptance probe exists under ${projectRoot}`);
}

function claudeVersion(config, workspace) {
  const result = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false,
    env: buildClaudeEnvironment(config, config.configurationDirectory, workspace), timeout: 15_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("Claude executable version could not be verified");
  return result.stdout.trim();
}

const adapter = arg("-Adapter");
if (adapter !== "claude") throw new Error("This acceptance harness is for Claude only");
const workspace = resolve(arg("-Workspace"));
const configPath = resolve(arg("-ConfigPath"));
const receiptPath = resolve(arg("-ReceiptPath"));
const config = JSON.parse(readFileSync(configPath, "utf8"));

if (!isAbsolute(config.assignedProjectRoot) || !existsSync(config.assignedProjectRoot)) throw new Error("Claude acceptance requires an existing assigned project root");
if (!Array.isArray(config.readableProjectRoots) || !config.readableProjectRoots.some((root) => isWithin(root, config.assignedProjectRoot))) {
  throw new Error("Assigned project is not inside a reviewed readable project root");
}
if (!Array.isArray(config.protectedPaths) || config.protectedPaths.length === 0) throw new Error("Protected paths are required");
if (config.enabled !== false || config.dispatchAuthorized !== false || config.implementationDispatchAuthorized !== false || config.automaticStartup !== false) {
  throw new Error("Persistent Claude dispatch guards must remain disabled during acceptance");
}

const writablePaths = Array.isArray(config.writableWorkspacePaths) ? config.writableWorkspacePaths : [];
const token = createHash("sha256").update(`${process.pid}:${Date.now()}:${workspace}`).digest("hex").slice(0, 24);
const runtimeDirectory = join(resolve(config.runtimeConfigurationRoot), `project-scope-${token}`);
const runtimePath = join(runtimeDirectory, "runtime.tmp");
const runtimeNeighbor = join(resolve(config.runtimeConfigurationRoot), `neighbor-${token}.tmp`);
// Validate the launch before creating temporary probe files, because workspace
// verification intentionally requires a pristine isolated repository.
const plan = buildClaudeImplementationPlan(config, workspace, "non-model project-scope acceptance");
const launch = buildClaudeContainmentLaunch(config, workspace, plan.args, writablePaths, runtimeDirectory);
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
const workspaceReadProbe = firstProjectProbe(workspace);
const authoritativeReadProbe = firstProjectProbe(resolve(config.deniedSourceRoot));
const authenticationSentinel = join(resolve(config.configurationDirectory), `.amadeus-auth-read-${token}.txt`);
writeFileSync(authenticationSentinel, `auth-read-${token}`, { flag: "wx" });
const protectedRoot = config.protectedPaths.find((path) => existsSync(path) && statSync(path).isDirectory());
if (!protectedRoot) throw new Error("At least one existing protected directory is required");
const protectedSentinel = join(protectedRoot, `.amadeus-protected-${token}.txt`);
writeFileSync(protectedSentinel, `protected-${token}`, { flag: "wx" });
const deniedDirectories = config.deniedParentPaths.filter((path) => existsSync(path) && statSync(path).isDirectory());
if (deniedDirectories.length === 0) throw new Error("At least one existing denied parent directory is required");
// Development workers may read the registered project, the workspace .git and
// its isolation receipt (as Codex development workers do); writes stay denied.
const developmentMode = config.developmentMode === true;

const before = {
  approved: approvedExisted ? sha256File(approvedPath) : null,
  workspaceReceipt: sha256File(workspaceReceipt),
};
const payload = Buffer.from(JSON.stringify({
  workspaceReadProbe, workspaceReadProbeHash: sha256File(workspaceReadProbe), authoritativeReadProbe,
  authenticationSentinel, authenticationSentinelHash: sha256File(authenticationSentinel),
  approvedPath, unapprovedPath, protectedSentinel, deniedDirectories,
  gitHead, workspaceReceipt, runtimePath, runtimeNeighbor,
}), "utf8").toString("base64");
const probe = String.raw`
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$readSucceeded = (Get-FileHash -Algorithm SHA256 -LiteralPath ([string]$p.workspaceReadProbe)).Hash -eq [string]$p.workspaceReadProbeHash
$authenticationReadSucceeded = (Get-FileHash -Algorithm SHA256 -LiteralPath ([string]$p.authenticationSentinel)).Hash -eq [string]$p.authenticationSentinelHash
$authoritativeReadDenied = $false
try { Get-Content -Raw -LiteralPath ([string]$p.authoritativeReadProbe) | Out-Null } catch { $authoritativeReadDenied = $true }
$assignedWriteSucceeded = $true
if ($p.approvedPath) { Set-Content -LiteralPath ([string]$p.approvedPath) -Value 'assigned-workspace-write'; $assignedWriteSucceeded = ((Get-Content -Raw -LiteralPath ([string]$p.approvedPath)).Trim() -eq 'assigned-workspace-write') }
$unapprovedDenied = $true
if ($p.unapprovedPath) { $unapprovedDenied = $false; try { Set-Content -LiteralPath ([string]$p.unapprovedPath) -Value 'escape' } catch { $unapprovedDenied = $true } }
$sourceWriteDenied = $false
$stream = $null
try { $stream = [IO.File]::Open([string]$p.authoritativeReadProbe, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite) } catch { $sourceWriteDenied = $true } finally { if ($stream) { $stream.Dispose() } }
$protectedDenied = $false
try { Get-Content -Raw -LiteralPath ([string]$p.protectedSentinel) | Out-Null } catch { $protectedDenied = $true }
$deniedReadable = @()
foreach ($directory in @($p.deniedDirectories)) {
  try { Get-ChildItem -LiteralPath ([string]$directory) -Force -ErrorAction Stop | Out-Null; $deniedReadable += [string]$directory } catch {}
}
$parentDenied = ($deniedReadable.Count -eq 0)
$gitReadDenied = $false
try { Get-Content -Raw -LiteralPath ([string]$p.gitHead) | Out-Null } catch { $gitReadDenied = $true }
$receiptReadDenied = $false
try { Get-Content -Raw -LiteralPath ([string]$p.workspaceReceipt) | Out-Null } catch { $receiptReadDenied = $true }
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
[ordered]@{ registeredReadsSucceeded=$readSucceeded; authenticationDirectoryReadAllowed=$authenticationReadSucceeded; authoritativeRepositoryDenied=$authoritativeReadDenied; assignedWorkspaceWriteSucceeded=$assignedWriteSucceeded; unapprovedWorkspaceWriteDenied=$unapprovedDenied; authoritativeRepositoryWritesDenied=$sourceWriteDenied; protectedPathDenied=$protectedDenied; parentPathDenied=$parentDenied; deniedPathsReadable=@($deniedReadable); gitHistoryReadDenied=$gitReadDenied; isolationReceiptReadDenied=$receiptReadDenied; gitHistoryWriteDenied=$gitWriteDenied; isolationReceiptWriteDenied=$receiptWriteDenied; runtimeWriteSucceeded=$runtimeWriteSucceeded; runtimeWriteError=$runtimeWriteError; runtimeNeighborDenied=$runtimeNeighborDenied } | ConvertTo-Json -Compress
`;

let result;
let execution;
try {
  const separator = launch.args.lastIndexOf("--");
  if (separator < 0) throw new Error("Claude containment launch has no command separator");
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
  rmSync(authenticationSentinel, { force: true });
  rmSync(runtimeNeighbor, { force: true });
  rmSync(runtimeDirectory, { recursive: true, force: true });
}

const after = { approved: approvedExisted ? sha256File(approvedPath) : null, workspaceReceipt: sha256File(workspaceReceipt) };
const workspaceRestored = before.approved === after.approved && before.workspaceReceipt === after.workspaceReceipt && (!unapprovedPath || !existsSync(unapprovedPath));
const passed = execution?.status === 0 && !execution.error && [
  result.registeredReadsSucceeded,
  result.authenticationDirectoryReadAllowed,
  developmentMode ? result.authoritativeRepositoryDenied === false : result.authoritativeRepositoryDenied,
  result.assignedWorkspaceWriteSucceeded,
  result.unapprovedWorkspaceWriteDenied,
  result.authoritativeRepositoryWritesDenied,
  result.protectedPathDenied,
  result.parentPathDenied,
  developmentMode || result.gitHistoryReadDenied,
  developmentMode || result.isolationReceiptReadDenied,
  result.gitHistoryWriteDenied,
  result.isolationReceiptWriteDenied,
  result.runtimeWriteSucceeded,
  result.runtimeNeighborDenied,
].every((value) => value === true) && workspaceRestored;
const attempt = { adapter, testedAt: new Date().toISOString(), modelInvoked: false, timedOut: execution?.error?.code === "ETIMEDOUT", exitCode: execution?.status ?? null, result, workspaceRestored, passed };
console.log(JSON.stringify(attempt));
if (!passed) throw new Error("Project-scope host acceptance failed for Claude");

mkdirSync(dirname(receiptPath), { recursive: true });
const security = claudeIsolationSecurityState(config, workspace, receiptPath);
const claudeAdapterPath = fileURLToPath(new URL("./claude-adapter.ts", import.meta.url));
const receipt = {
  schemaVersion: 1,
  executableVersion: claudeVersion(config, workspace),
  executableSha256: sha256File(config.executable),
  containmentExecutableSha256: sha256File(config.containmentExecutable),
  adapterSha256: sha256File(claudeAdapterPath),
  acceptanceHarnessPath: fileURLToPath(import.meta.url),
  acceptanceHarnessSha256: sha256File(fileURLToPath(import.meta.url)),
  isolationEnvelopeSha256: claudeIsolationEnvelopeSha256(config, workspace),
  ...security,
  workspace,
  developmentMode,
  authoritativeRepositoryDenied: !developmentMode,
  registeredProjectReadsAllowed: true,
  unassignedProjectWritesDenied: true,
  protectedPathsDenied: true,
  parentUserDirectoryDenied: true,
  writableWorkspacePaths: writablePaths,
  outsideWorkspaceWritesDenied: true,
  unapprovedWorkspaceWritesDenied: true,
  gitHistoryDenied: !developmentMode,
  isolationReceiptDenied: !developmentMode,
  gitHistoryWritesDenied: true,
  isolationReceiptWritesDenied: true,
  deniedPathsProbed: deniedDirectories.length,
  containmentExecutable: config.containmentExecutable,
  containmentProfile: config.containmentProfile,
  containmentWindowsSandbox: config.containmentWindowsSandbox,
  containedAppData: config.containedAppData,
  containedUsername: config.containedUsername,
  containedUserProfile: config.containedUserProfile,
  userInfoShim: config.userInfoShim,
  userInfoShimSha256: sha256File(config.userInfoShim),
  runtimeConfigurationRoot: config.runtimeConfigurationRoot,
  runtimeConfigurationWritesRestricted: true,
  runtimeConfigurationWriteProbePassed: true,
  runtimeConfigurationNeighborDenied: true,
  testedAt: new Date().toISOString(),
  apiKeyAuthenticationAllowed: false,
  credentialsCopied: false,
  authenticationDirectoryReadAllowed: true,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify(receipt));
