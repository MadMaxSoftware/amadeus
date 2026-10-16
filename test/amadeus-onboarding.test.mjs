import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { onboardingStatus, recordDiscoveryChoice, configureRuntime, setupPackagedRuntime,
  isMigratableCursorConfig } from "../plugins/amadeus/scripts/privacy-onboarding.mjs";
import { detectAccelerators } from "../plugins/amadeus/scripts/amadeus-runtime.mjs";
import { discoverProviders, probeTarget, defaultDiscoveryPaths, grantDiscoveryConsent, hasDiscoveryConsent } from "../plugins/amadeus/scripts/provider-discovery.mjs";
import { runLifecycleStatus } from "../plugins/amadeus/scripts/amadeus-lifecycle.mjs";
import { checkForUpdate } from "../plugins/amadeus/scripts/update-manager.mjs";
import { readModelCatalog } from "../src/model-catalog.ts";
import { inspectCursorCli } from "../src/cursor-adapter.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amadeus-privacy-test-"));
  return { dir, stateRoot: join(dir, "state"), configPath: join(dir, "config.json") };
}
const never = () => { throw new Error("Unexpected collection"); };

test("missing, legacy, malformed, revoked and wrong-scope consent block every discovery entry point", async () => {
  const f = fixture();
  const paths = defaultDiscoveryPaths(f.stateRoot);
  const candidates = [undefined, {}, { discovery: true }, { discovery: true, allowLan: false, disclosureVersion: 1 },
    { discovery: false, allowLan: false, disclosureVersion: 3, scopes: ["local-providers", "development-tools"], grantedAt: "2026-10-13T00:00:00Z" }];
  for (const consent of candidates) {
    assert.equal((await discoverProviders({ paths, consent, probe: never })).status, "consent-required");
    await assert.rejects(probeTarget({ url: "http://127.0.0.1:1234" }, never, { consent }), /consent/);
  }
  mkdirSync(join(f.stateRoot, "providers"), { recursive: true });
  writeFileSync(paths.consentPath, "{broken");
  assert.equal((await discoverProviders({ paths, probe: never })).status, "consent-required");
  const localOnly = grantDiscoveryConsent(paths.consentPath, new Date(), ["local-providers"]);
  assert.equal(hasDiscoveryConsent(localOnly, "hardware"), false);
  assert.throws(() => grantDiscoveryConsent(paths.consentPath, new Date(), ["personal-documents"]), /Unsupported/);
  assert.equal(existsSync(paths.lastScanPath), false);
});

test("first-run status is read-only; grant, revoke and setup never collect inventory", async () => {
  const f = fixture();
  const first = onboardingStatus(f);
  assert.equal(first.onboardingRequired, true);
  assert.equal(existsSync(f.stateRoot), false);
  assert.throws(() => recordDiscoveryChoice({ consent: true }, f), /disclosure/);
  assert.throws(() => recordDiscoveryChoice({ consent: "yes", disclosureVersion: 3 }, f), /explicit/);
  const allowed = recordDiscoveryChoice({ consent: true, disclosureVersion: 3 }, f);
  assert.equal(allowed.discoveryConsent, "granted");
  assert.equal(allowed.collectionStarted, false);
  assert.equal(existsSync(defaultDiscoveryPaths(f.stateRoot).lastScanPath), false);
  const consentText = readFileSync(allowed.consentPath, "utf8");
  const runtime = join(f.dir, "runtime");
  mkdirSync(join(runtime, "src"), { recursive: true });
  writeFileSync(join(runtime, "src", "coordinator.ts"), "export {};");
  configureRuntime({ setupRoot: runtime }, f);
  assert.equal(readFileSync(allowed.consentPath, "utf8"), consentText);
  const denied = recordDiscoveryChoice({ consent: false }, f);
  assert.equal(denied.discoveryConsent, "declined");
  assert.equal(denied.onboardingRequired, false);
  assert.equal((await discoverProviders({ stateRoot: f.stateRoot, probe: never })).status, "consent-required");
});

test("packaged setup restores a proven host Cursor config and preserves later owner changes", () => {
  const f = fixture();
  const legacyRoot = join(f.dir, "legacy-host");
  const legacyCoordinator = join(legacyRoot, "coordinator");
  const runtimeConfig = join(f.stateRoot, "runtime-config");
  const cursorConfigPath = join(runtimeConfig, "cursor-worker-config.json");
  const executable = join(f.dir, "cursor-agent.exe");
  const containmentExecutable = join(f.dir, "containment.exe");
  const userInfoShim = join(f.dir, "userinfo.cjs");
  const pathVerifierShim = join(f.dir, "path-verifier.cjs");
  const harness = join(f.dir, "acceptance.ps1");
  const securityProbe = join(f.dir, "security-state.ps1");
  const containedAppData = join(f.dir, "contained-appdata");
  const containedUserProfile = join(f.dir, "contained-profile");
  const configurationDirectory = join(f.dir, "cursor-cli");
  const authenticationFile = join(f.dir, "Cursor", "auth.json");
  const runtimeConfigurationRoot = join(containedAppData, "runtime");
  const readableRoot = join(f.dir, "projects");
  for (const directory of [legacyCoordinator, runtimeConfig, containedAppData, containedUserProfile,
    configurationDirectory, runtimeConfigurationRoot, readableRoot]) mkdirSync(directory, { recursive: true });
  mkdirSync(dirname(authenticationFile), { recursive: true });
  for (const file of [executable, containmentExecutable, userInfoShim, pathVerifierShim, harness, securityProbe, authenticationFile]) {
    writeFileSync(file, "fixture");
  }
  const legacyCursor = {
    schemaVersion: 1,
    enabled: true,
    dispatchAuthorized: true,
    implementationDispatchAuthorized: true,
    automaticStartup: false,
    executable,
    executableArguments: [],
    containmentExecutable,
    containmentProfile: "cursor_contained",
    containmentWindowsSandbox: "mxc",
    containedAppData,
    containedUsername: "fixture",
    containedUserProfile,
    userInfoShim,
    pathVerifierShim,
    authentication: "browser-login",
    authenticationFile,
    apiKeyAuthenticationAllowed: false,
    spendingRouteReviewed: true,
    readOnlyOnly: false,
    mode: "ask",
    sandbox: "disabled",
    outputFormat: "stream-json",
    assignedProjectRoot: readableRoot,
    readableProjectRoots: [readableRoot],
    deniedParentPaths: [],
    protectedPaths: [],
    configurationDirectory,
    runtimeConfigurationRoot,
    writableWorkspacePaths: [],
    isolationAcceptanceHarness: harness,
    isolationSecurityStateProbe: securityProbe,
  };
  assert.equal(isMigratableCursorConfig(legacyCursor), true);
  assert.equal(isMigratableCursorConfig({ ...legacyCursor, executable: readableRoot }), false);
  assert.equal(isMigratableCursorConfig({ ...legacyCursor, configurationDirectory: executable }), false);
  writeFileSync(join(legacyCoordinator, "cursor-worker-config.json"), JSON.stringify(legacyCursor));
  writeFileSync(f.configPath, JSON.stringify({ schemaVersion: 3, runtimeAuthority: "packaged",
    developerMode: false, stateRoot: f.stateRoot, legacySetupRootHint: legacyRoot }));
  cpSync(join(root, "plugins", "amadeus", "runtime", "config-templates", "cursor-worker-config.json"), cursorConfigPath);

  const template = JSON.parse(readFileSync(cursorConfigPath, "utf8"));
  writeFileSync(cursorConfigPath, JSON.stringify(Object.fromEntries(Object.entries(template).reverse())));
  configureRuntime({}, f);
  assert.equal(JSON.parse(readFileSync(f.configPath, "utf8")).legacySetupRootHint, legacyRoot);
  setupPackagedRuntime(f);
  const packagedCursorStateRoot = join(f.stateRoot, "providers", "cursor");
  const packagedProtectedPaths = [
    "runtime-config", "goal-packages", "goal-runs", "active-goal-runs", "patches",
    "project-checkpoints", "reconciliation-backups", "repair-artifacts",
    "retired-goal-run-locks", "updates", "preferences.json", "worker-source-manifest.json",
    "coordinator.sqlite", "coordinator.sqlite-shm", "coordinator.sqlite-wal",
    join("providers", "codex"), join("providers", "claude"),
  ].map((path) => join(f.stateRoot, path));
  const migratedCursor = {
    ...legacyCursor,
    containedAppData: join(packagedCursorStateRoot, "appdata"),
    containedUserProfile: join(packagedCursorStateRoot, "profile"),
    userInfoShim: join(root, "plugins", "amadeus", "runtime", "src", "cursor-windows-userinfo-shim.cjs"),
    pathVerifierShim: join(root, "plugins", "amadeus", "runtime", "src", "cursor-path-verifier-shim.cjs"),
    protectedPaths: packagedProtectedPaths,
    runtimeConfigurationRoot: join(packagedCursorStateRoot, "appdata", "runtime"),
    isolationAcceptanceHarness: join(root, "plugins", "amadeus", "runtime", "src", "cursor-project-scope-acceptance.mjs"),
    isolationSecurityStateProbe: join(root, "plugins", "amadeus", "runtime", "src", "isolation-security-state.ps1"),
  };
  assert.deepEqual(JSON.parse(readFileSync(cursorConfigPath, "utf8")), migratedCursor);
  assert.equal(isMigratableCursorConfig(migratedCursor), true);

  const ownerEdited = {
    ...legacyCursor,
    model: "owner-choice",
    isolationAcceptanceHarness: join(f.dir, "removed-plugin", "cursor-project-scope-acceptance.mjs"),
    isolationSecurityStateProbe: join(f.dir, "removed-plugin", "isolation-security-state.ps1"),
  };
  writeFileSync(cursorConfigPath, JSON.stringify(ownerEdited));
  setupPackagedRuntime(f);
  assert.deepEqual(JSON.parse(readFileSync(cursorConfigPath, "utf8")), { ...ownerEdited,
    containedAppData: migratedCursor.containedAppData,
    containedUserProfile: migratedCursor.containedUserProfile,
    userInfoShim: migratedCursor.userInfoShim,
    pathVerifierShim: migratedCursor.pathVerifierShim,
    protectedPaths: migratedCursor.protectedPaths,
    runtimeConfigurationRoot: migratedCursor.runtimeConfigurationRoot,
    isolationAcceptanceHarness: migratedCursor.isolationAcceptanceHarness,
    isolationSecurityStateProbe: migratedCursor.isolationSecurityStateProbe });
  rmSync(f.dir, { recursive: true, force: true });
});

test("packaged setup rejects an incomplete legacy Cursor config", () => {
  const f = fixture();
  const legacyRoot = join(f.dir, "legacy-host");
  mkdirSync(join(legacyRoot, "coordinator"), { recursive: true });
  writeFileSync(join(legacyRoot, "coordinator", "cursor-worker-config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, dispatchAuthorized: true, authentication: "browser-login",
  }));
  writeFileSync(f.configPath, JSON.stringify({ schemaVersion: 3, runtimeAuthority: "packaged",
    developerMode: false, stateRoot: f.stateRoot, legacySetupRootHint: legacyRoot }));
  setupPackagedRuntime(f);
  const installed = JSON.parse(readFileSync(join(f.stateRoot, "runtime-config", "cursor-worker-config.json"), "utf8"));
  assert.equal(installed.enabled, false);
  assert.equal(installed.dispatchAuthorized, false);
  rmSync(f.dir, { recursive: true, force: true });
});

test("consented discovery uses only injected fake transports in tests", async () => {
  const f = fixture();
  const consent = grantDiscoveryConsent(defaultDiscoveryPaths(f.stateRoot).consentPath);
  const calls = [];
  const report = detectAccelerators({ consent, which: name => { calls.push(name); return null; } });
  assert.equal(report.codex.available, false);
  assert.deepEqual(calls, ["cursor-agent", "cursor", "codex", "git"]);
  const providers = await discoverProviders({ stateRoot: f.stateRoot, includeKnown: false,
    manualEndpoints: ["http://127.0.0.1:9999"], probe: async () => ({ ok: true, body: { data: [{ id: "fake-model" }] } }) });
  assert.equal(providers.availableCount, 1);
});

test("lifecycle status never writes state or invokes update transport", async () => {
  const f = fixture();
  await runLifecycleStatus({ stateRoot: f.stateRoot, currentVersion: "0.3.1", fetchLatestRelease: never });
  assert.equal(existsSync(f.stateRoot), false);
  mkdirSync(join(f.stateRoot, "updates"), { recursive: true });
  writeFileSync(join(f.stateRoot, "updates", "consent.json"), JSON.stringify({ updateChecks: true }));
  await runLifecycleStatus({ stateRoot: f.stateRoot, currentVersion: "0.3.1", fetchLatestRelease: never });
  assert.equal(existsSync(join(f.stateRoot, "providers")), false);
});

test("a consented update check runs at most once per 24 hours", async () => {
  const f = fixture();
  mkdirSync(join(f.stateRoot, "updates"), { recursive: true });
  writeFileSync(join(f.stateRoot, "updates", "consent.json"), JSON.stringify({ updateChecks: true }));
  let calls = 0;
  const boot = await checkForUpdate({
    stateRoot: f.stateRoot,
    currentVersion: "0.3.1",
    fetchLatestRelease: async () => { calls++; return { tag_name: "v0.3.2", html_url: "https://github.com/MadMaxSoftware/amadeus/releases/tag/v0.3.2", published_at: "2026-10-13T00:00:00Z", body: "n" }; },
  });
  assert.equal(calls, 1);
  assert.equal(boot.checked, true);
  const skipped = await checkForUpdate({
    stateRoot: f.stateRoot,
    currentVersion: "0.3.1",
    fetchLatestRelease: never,
  });
  assert.equal(skipped.status, "skipped-interval");
});

test("cached model catalog remains usable with optional discovery disabled", () => {
  const f = fixture(); const fakeCatalog = join(f.dir, "fake-catalog"); mkdirSync(fakeCatalog);
  writeFileSync(join(fakeCatalog, "models_cache.json"), JSON.stringify({ fetched_at: "test", models: [
    { slug: "fake-model", visibility: "list", priority: 0, supported_reasoning_levels: [] }] }));
  assert.equal(readModelCatalog(fakeCatalog).models[0].slug, "fake-model");
  assert.equal(detectAccelerators({ which: () => null }).codex.available, false);
});

test("revocation during a fake scan stops subsequent probes and prevents a report", async () => {
  const f = fixture();
  recordDiscoveryChoice({ consent: true, disclosureVersion: 3 }, f);
  let calls = 0;
  const report = await discoverProviders({ stateRoot: f.stateRoot, probe: async () => {
    calls++; recordDiscoveryChoice({ consent: false }, f);
    return { ok: true, body: { data: [{ id: "fake-model" }] } };
  } });
  assert.equal(report.status, "consent-required");
  assert.equal(calls, 1);
  assert.equal(existsSync(defaultDiscoveryPaths(f.stateRoot).lastScanPath), false);
});

test("noninteractive privacy onboarding stays off and explicit fixture consent never scans", () => {
  const f = fixture();
  const env = { ...process.env, AMADEUS_CONFIG: f.configPath, AMADEUS_HOME: f.stateRoot,
    AMADEUS_SETUP_ROOT: "", PATH: "" };
  const run = (extra = []) => spawnSync(process.execPath, [join(root, "plugins", "amadeus", "scripts", "onboard.mjs"),
    "--privacy-only", "--non-interactive", ...extra], { env, cwd: f.dir, encoding: "utf8", timeout: 10000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).discoveryConsent, "not-granted");
  assert.equal(existsSync(f.stateRoot), false);
  const grant = run(["--discovery-consent", "allow"]);
  assert.equal(grant.status, 0, grant.stderr);
  assert.equal(JSON.parse(grant.stdout).discoveryConsent, "granted");
  assert.equal(existsSync(defaultDiscoveryPaths(f.stateRoot).lastScanPath), false);
  assert.equal(existsSync(f.configPath), false);
});

test("packaged server initializes and offers privacy onboarding without coordinator, network or executable probes", () => {
  const f = fixture();
  const pkg = join(f.dir, "plugin");
  cpSync(join(root, "plugins", "amadeus"), pkg, { recursive: true });
  rmSync(join(pkg, "runtime"), { recursive: true, force: true });
  const guard = join(f.dir, "guard.mjs");
  writeFileSync(guard, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    for (const k of ['exec','execSync','execFile','execFileSync','spawn','spawnSync']) cp[k]=()=>{throw new Error('Collection forbidden: '+k)};
    syncBuiltinESMExports(); globalThis.fetch=()=>{throw new Error('Network forbidden')};`);
  const env = { ...process.env, AMADEUS_CONFIG: f.configPath, AMADEUS_HOME: f.stateRoot,
    AMADEUS_SETUP_ROOT: "", PATH: "" };
  const requests = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "amadeus_onboarding_status", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "amadeus_discovery_run", arguments: { requested: true } } },
    { id: 5, method: "tools/call", params: { name: "amadeus_discover_providers", arguments: { requested: true } } },
  ];
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, join(pkg, "scripts", "server.mjs")], {
    env, cwd: f.dir, input: requests.map(x => JSON.stringify({ jsonrpc: "2.0", ...x })).join("\n") + "\n", encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split("\n").map(x => JSON.parse(x));
  const byId = id => replies.find(x => x.id === id).result;
  assert.match(byId(1).instructions, /amadeus_onboarding_status/);
  assert.ok(byId(2).tools.some(x => x.name === "amadeus_onboarding_status"));
  assert.equal(byId(3).structuredContent.runtimeConfigured, false);
  assert.equal(byId(3).structuredContent.onboardingRequired, true);
  assert.equal(byId(4).structuredContent.status, "consent-required");
  assert.equal(byId(5).structuredContent.status, "consent-required");
  assert.equal(existsSync(f.stateRoot), false);
  assert.equal(existsSync(f.configPath), false);
});
