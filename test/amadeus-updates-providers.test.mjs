import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scripts = join(root, "plugins", "amadeus", "scripts");

const updateUrl = pathToFileURL(join(scripts, "update-manager.mjs")).href;
const discoveryUrl = pathToFileURL(join(scripts, "provider-discovery.mjs")).href;
const registryUrl = pathToFileURL(join(scripts, "provider-registry.mjs")).href;
const qualifyUrl = pathToFileURL(join(scripts, "capability-qualification.mjs")).href;
const workerUrl = pathToFileURL(join(scripts, "local-model-worker.mjs")).href;
const routingUrl = pathToFileURL(join(scripts, "local-model-routing.mjs")).href;
const lifecycleUrl = pathToFileURL(join(scripts, "amadeus-lifecycle.mjs")).href;
const runtimeUrl = pathToFileURL(join(scripts, "amadeus-runtime.mjs")).href;

const update = await import(updateUrl);
const discovery = await import(discoveryUrl);
const registry = await import(registryUrl);
const qualify = await import(qualifyUrl);
const worker = await import(workerUrl);
const localRouting = await import(routingUrl);
const lifecycle = await import(lifecycleUrl);
const runtime = await import(runtimeUrl);

function tempState() {
  return mkdtempSync(join(tmpdir(), "amadeus-lifecycle-"));
}

test("semver compare: newer, equal, older, malformed", () => {
  assert.equal(update.compareSemver("0.3.1", "0.3.0"), 1);
  assert.equal(update.compareSemver("0.3.0", "0.3.0"), 0);
  assert.equal(update.compareSemver("0.2.9", "0.3.0"), -1);
  assert.equal(update.classifyUpdate("0.3.0", "0.3.1").kind, "newer");
  assert.equal(update.classifyUpdate("0.3.0", "0.3.0").kind, "equal");
  assert.equal(update.classifyUpdate("0.3.1", "0.3.0").kind, "older");
  assert.equal(update.classifyUpdate("not-a-version", "0.3.0").kind, "malformed");
  assert.equal(update.classifyUpdate("0.3.0", "nope").kind, "malformed");
  assert.throws(() => update.parseSemver("1.2"), /malformed/);
});

test("update check requires consent and only allows MadMaxSoftware/amadeus", async () => {
  const stateRoot = tempState();
  const paths = update.defaultUpdatePaths(stateRoot);
  const declined = update.declineUpdateConsent(paths.consentPath);
  assert.equal(update.hasUpdateConsent(declined), false);
  const blocked = await update.checkForUpdate({
    stateRoot,
    paths,
    currentVersion: "0.3.0",
    fetchLatestRelease: async () => ({ tag_name: "v0.3.1" }),
  });
  assert.equal(blocked.status, "consent-required");
  assert.equal(blocked.checked, false);

  update.grantUpdateConsent(paths.consentPath);
  assert.throws(
    () => update.assertAllowedReleaseRepo("evil/other"),
    (err) => err.code === "DISALLOWED_UPDATE_REPO",
  );
});

test("update check: newer/equal/older/unavailable/malformed and 24h interval", async () => {
  const stateRoot = tempState();
  const paths = update.defaultUpdatePaths(stateRoot);
  update.grantUpdateConsent(paths.consentPath);
  const now = new Date("2026-10-13T00:00:00.000Z");

  const newer = await update.checkForUpdate({
    paths,
    currentVersion: "0.3.0",
    now,
    force: true,
    fetchLatestRelease: async ({ repo }) => {
      assert.equal(repo, "MadMaxSoftware/amadeus");
      return {
        tag_name: "v0.3.1",
        name: "0.3.1",
        body: "Fixes",
        published_at: "2026-10-12T00:00:00.000Z",
        html_url: "https://github.com/MadMaxSoftware/amadeus/releases/tag/v0.3.1",
      };
    },
  });
  assert.equal(newer.status, "newer");
  assert.equal(newer.ownerVisible.repo, "MadMaxSoftware/amadeus");
  assert.equal(newer.activationRequiresApproval, true);
  assert.equal(newer.hotReplacement, false);
  assert.equal(newer.marketplaceUpgradeCommand, update.MARKETPLACE_UPGRADE_COMMAND);

  const skipped = await update.checkForUpdate({
    paths,
    currentVersion: "0.3.0",
    now: new Date("2026-10-13T12:00:00.000Z"),
    fetchLatestRelease: async () => ({ tag_name: "v0.9.0" }),
  });
  assert.equal(skipped.status, "skipped-interval");

  const equal = await update.checkForUpdate({
    paths,
    currentVersion: "0.3.1",
    now: new Date("2026-10-14T01:00:00.000Z"),
    force: true,
    fetchLatestRelease: async () => ({ tag_name: "0.3.1" }),
  });
  assert.equal(equal.status, "equal");

  const older = await update.checkForUpdate({
    paths,
    currentVersion: "0.4.0",
    force: true,
    fetchLatestRelease: async () => ({ tag_name: "0.3.0" }),
  });
  assert.equal(older.status, "older");

  const unavailable = await update.checkForUpdate({
    paths,
    currentVersion: "0.3.0",
    force: true,
    fetchLatestRelease: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(unavailable.status, "unavailable");

  const malformed = await update.checkForUpdate({
    paths,
    currentVersion: "0.3.0",
    force: true,
    fetchLatestRelease: async () => ({ tag_name: "not-semver" }),
  });
  assert.equal(malformed.status, "malformed");
});

test("stage/approve/rollback with pending-restart and no hot replacement; partial rejected", () => {
  const stateRoot = tempState();
  const paths = update.defaultUpdatePaths(stateRoot);
  const release = {
    version: "0.3.1",
    tag: "0.3.1",
    repo: "MadMaxSoftware/amadeus",
    name: "0.3.1",
    body: "notes",
  };
  const partial = update.stageUpdate({
    paths,
    release,
    files: [{ path: "README.md", content: "hi\n" }],
  });
  assert.equal(partial.status, "partial");

  const pluginJson = JSON.stringify({
    name: "amadeus",
    version: "0.3.1+amadeus.20261013010000",
  }, null, 2);
  const staged = update.stageUpdate({
    paths,
    release,
    files: [
      { path: "plugins/amadeus/.codex-plugin/plugin.json", content: `${pluginJson}\n` },
      { path: "package.json", content: "{\"version\":\"0.3.1\"}\n" },
    ],
  });
  assert.equal(staged.status, "staged");

  const denied = update.approveActivation({ paths, approval: false });
  assert.equal(denied.status, "approval-required");

  const approved = update.approveActivation({
    paths,
    approval: true,
    currentVersion: "0.3.0",
    currentFiles: [
      { path: "plugins/amadeus/.codex-plugin/plugin.json", content: "{\"version\":\"0.3.0\"}\n" },
    ],
  });
  assert.equal(approved.status, "pending-restart");
  assert.equal(approved.pendingRestart.hotReplacement, false);
  assert.match(approved.pendingRestart.marketplaceUpgradeCommand, /marketplace upgrade amadeus/);
  assert.equal(approved.rollbackPreserved, true);

  const rolled = update.rollbackUpdate({ paths, targetDir: join(stateRoot, "restored") });
  assert.equal(rolled.status, "rolled-back");
  assert.equal(rolled.restoredVersion, "0.3.0");
  assert.ok(existsSync(join(stateRoot, "restored", "plugins", "amadeus", ".codex-plugin", "plugin.json")));
});

test("provider discovery: declined consent, no LAN, loopback-only, manual endpoint", async () => {
  const stateRoot = tempState();
  const paths = discovery.defaultDiscoveryPaths(stateRoot);
  discovery.declineDiscoveryConsent(paths.consentPath);
  const declined = await discovery.discoverProviders({
    paths,
    probe: async () => ({ ok: true, body: { data: [{ id: "x" }] } }),
  });
  assert.equal(declined.status, "consent-required");

  discovery.grantDiscoveryConsent(paths.consentPath);
  assert.throws(() => discovery.assertLoopbackOnly("http://192.168.1.10:11434"), (err) => err.code === "NON_LOOPBACK" || err.code === "LAN_FORBIDDEN");
  assert.throws(() => discovery.assertLoopbackOnly("http://10.0.0.2:11434"), (err) => err.code === "LAN_FORBIDDEN" || err.code === "NON_LOOPBACK");

  const report = await discovery.discoverProviders({
    paths,
    includeKnown: true,
    manualEndpoints: ["http://127.0.0.1:9999"],
    probe: async ({ url }) => {
      if (url.includes("11434")) {
        return { ok: true, status: 200, body: { models: [{ name: "llama-test" }] } };
      }
      if (url.includes("9999")) {
        return { ok: true, status: 200, body: { data: [{ id: "manual-model" }] } };
      }
      return { ok: false, status: 404, reason: "absent" };
    },
  });
  assert.equal(report.status, "scanned");
  assert.equal(report.lanScan, false);
  assert.equal(report.routingAuthorityGranted, false);
  assert.ok(report.discovered.some((d) => d.available && d.providerId === "ollama"));
  assert.ok(report.discovered.every((d) => d.routingAuthority === false));
  assert.ok(report.discovered.some((d) => String(d.endpoint).includes("9999")));
});

test("registry: detection without approval grants no routing; approval/enable/qualify path", async () => {
  const stateRoot = tempState();
  const registryPath = registry.defaultRegistryPath(stateRoot);
  let reg = registry.emptyRegistry();
  reg = registry.recordDiscovery(reg, {
    discovered: [{
      providerId: "ollama",
      kind: "ollama",
      endpoint: "http://127.0.0.1:11434/api/tags",
      openaiEndpoint: "http://127.0.0.1:11434/v1/models",
      available: true,
      models: [{ id: "llama-test" }],
      routingAuthority: true, // must be ignored
      source: "known-loopback-default",
    }],
  });
  assert.equal(reg.providers.ollama.approved, false);
  assert.equal(reg.providers.ollama.routingAuthority, false);
  assert.equal(registry.listRoutableProviders(reg, { pilotGateOpen: true }).length, 0);

  reg = registry.approveProvider(reg, "ollama", true);
  assert.throws(() => registry.enableProvider(registry.emptyRegistry(), "missing", true), (err) => err.code === "UNKNOWN_PROVIDER");
  // enable before approve on a fresh copy should fail
  const unapproved = registry.recordDiscovery(registry.emptyRegistry(), {
    discovered: [{ providerId: "x", kind: "ollama", endpoint: "http://127.0.0.1:1", available: true, models: [] }],
  });
  assert.throws(() => registry.enableProvider(unapproved, "x", true), (err) => err.code === "APPROVAL_REQUIRED");

  reg = registry.enableProvider(reg, "ollama", true);
  const qualification = await qualify.qualifyProvider({
    provider: reg.providers.ollama,
    probeModel: async () => ({
      ok: true,
      latencyMs: 120,
      output: { choices: [{ message: { content: "ok" } }] },
      capabilities: ["openai-compatible-chat"],
    }),
  });
  assert.equal(qualification.status, "qualified");
  reg = registry.setProviderQualification(reg, "ollama", qualification);
  registry.saveRegistry(registryPath, reg);

  assert.equal(registry.listRoutableProviders(reg, { requirePilotGate: true, pilotGateOpen: false }).length, 0);
  assert.equal(registry.listRoutableProviders(reg, { requirePilotGate: true, pilotGateOpen: true }).length, 1);
});

test("capability qualification excludes inadequate/malformed/slow/disappearing/unqualified", async () => {
  const base = {
    id: "ollama",
    approved: true,
    enabled: true,
    endpoint: "http://127.0.0.1:11434/v1",
    models: [{ id: "m1" }],
  };
  assert.equal((await qualify.qualifyProvider({
    provider: base,
    probeModel: async () => ({ ok: false, reason: "too weak" }),
  })).status, "inadequate");
  assert.equal((await qualify.qualifyProvider({
    provider: base,
    probeModel: async () => ({ ok: true, malformed: true, latencyMs: 10, output: {} }),
  })).status, "malformed");
  assert.equal((await qualify.qualifyProvider({
    provider: base,
    probeModel: async () => ({ ok: true, latencyMs: 60_000, output: { choices: [{ message: { content: "x" } }] } }),
  })).status, "slow");
  assert.equal((await qualify.qualifyProvider({
    provider: base,
    probeModel: async () => ({ disappeared: true }),
  })).status, "disappeared");
  assert.equal(qualify.excludeUnqualifiedFromRouting([{
    approved: true, enabled: true, qualification: { status: "inadequate", routable: false },
  }]).length, 0);
});

test("local worker isolation + privacy envelope; pilot gate closed on stable", async () => {
  assert.equal(worker.isLocalModelPilotGateOpen({ releaseChannel: "stable", experimentalEnabled: true, friendPilotPassed: true }), false);
  assert.equal(worker.isLocalModelPilotGateOpen({
    releaseChannel: "experimental",
    experimentalEnabled: true,
    friendPilotPassed: true,
  }), true);
  assert.equal(worker.isLocalModelPilotGateOpen({
    releaseChannel: "experimental",
    experimentalEnabled: true,
    friendPilotPassed: false,
  }), false);

  const config = worker.createIsolatedWorkerConfig({ endpoint: "http://127.0.0.1:11434/v1" });
  assert.equal(config.networkPolicy, "loopback-only");
  assert.equal(config.telemetry, false);
  assert.equal(config.isolation.readCredentials, false);
  assert.throws(() => worker.createIsolatedWorkerConfig({ endpoint: "http://192.168.0.5:11434/v1" }));
  assert.throws(() => worker.assertToolAllowed("shell_exec", config.toolAllowlist), (err) => err.code === "TOOL_DENIED");

  const gated = await worker.runIsolatedLocalCompletion({
    endpoint: "http://127.0.0.1:11434/v1",
    model: "llama-test",
    pilotGate: { releaseChannel: "stable" },
    transport: async () => ({ ok: true, output: { choices: [{ message: { content: "hi" } }] } }),
  });
  assert.equal(gated.status, "pilot-gate-closed");
  assert.equal(gated.fallbackSuggested, true);

  const open = await worker.runIsolatedLocalCompletion({
    endpoint: "http://127.0.0.1:11434/v1",
    model: "llama-test",
    pilotGate: { releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true },
    requestedTools: ["read_file"],
    providerApproved: true,
    transport: async ({ privacy }) => {
      assert.equal(privacy.loopbackOnly, true);
      assert.equal(privacy.noTelemetry, true);
      return { ok: true, output: { choices: [{ message: { content: "hi" } }] } };
    },
  });
  assert.equal(open.status, "completed");
});

test("local routing: stable disabled; experimental uses qualified only; software first", () => {
  const stable = localRouting.stableChannelLocalRoutingStatus();
  assert.equal(stable.localAutomaticRouting, false);
  assert.equal(stable.pilotGateOpen, false);

  const closed = localRouting.selectQualifiedLocalRoute({
    pilotGate: { releaseChannel: "stable" },
    candidates: [{
      id: "ollama",
      approved: true,
      enabled: true,
      models: [{ id: "m1" }],
      qualification: { status: "qualified", routable: true, qualifiedModelIds: ["m1"] },
    }],
  });
  assert.equal(closed.route, null);

  const open = localRouting.selectQualifiedLocalRoute({
    pilotGate: { releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true },
    candidates: [{
      id: "ollama",
      approved: true,
      enabled: true,
      openaiEndpoint: "http://127.0.0.1:11434/v1",
      models: [{ id: "m1" }],
      qualification: { status: "qualified", routable: true, qualifiedModelIds: ["m1"], models: [{ status: "qualified", latencyMs: 50 }] },
    }],
  });
  assert.equal(open.route.provider, "local-openai-compatible");
  assert.equal(open.route.model, "m1");

  const softwareFirst = localRouting.planRouteWithLocalModels({
    softwareRoute: { provider: "software", model: null },
    pilotGate: { releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true },
    candidates: open.route ? [open.route] : [],
  });
  assert.equal(softwareFirst.primary.provider, "software");
});

test("config migration and lifecycle startup privacy defaults", async () => {
  const stateRoot = tempState();
  const configPath = join(stateRoot, "config.json");
  const v1 = {
    schemaVersion: 1,
    product: "Amadeus",
    setupRoot: stateRoot,
    stateRoot,
  };
  writeFileSync(configPath, `${JSON.stringify(v1, null, 2)}\n`);
  const migrated = runtime.migrateMachineConfig(JSON.parse(readFileSync(configPath, "utf8")));
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.runtimeAuthority, "packaged");
  assert.equal(migrated.developerMode, false);
  assert.equal(migrated.consents.updateChecks, false);
  assert.equal(migrated.consents.providerDiscovery, false);
  assert.equal(migrated.localModelRouting.experimentalPilotGate, false);

  const written = runtime.writeMachineConfig({ stateRoot }, configPath);
  assert.equal(written.schemaVersion, 3);
  assert.equal(written.runtimeAuthority, "packaged");
  assert.ok(written.lifecycle.providerRegistry.includes("providers"));

  const boot = await lifecycle.runStartupLifecycle({
    stateRoot,
    currentVersion: "0.3.0",
    fetchLatestRelease: async () => ({ tag_name: "0.3.1" }),
  });
  assert.equal(boot.updates.status, "consent-required");
  assert.equal(boot.localRouting.localAutomaticRouting, false);
  assert.equal(boot.pilotGate.open, false);
});

test("clean-machine fallback: no providers, gate closed, subscription guidance intact", async () => {
  const stateRoot = tempState();
  const paths = discovery.defaultDiscoveryPaths(stateRoot);
  discovery.grantDiscoveryConsent(paths.consentPath);
  const report = await discovery.discoverProviders({
    paths,
    includeKnown: true,
    probe: async () => ({ ok: false, status: 0, reason: "nothing listening" }),
  });
  assert.equal(report.availableCount, 0);
  let reg = registry.recordDiscovery(registry.emptyRegistry(), report);
  assert.equal(registry.listRoutableProviders(reg, { pilotGateOpen: true }).length, 0);
  const plan = localRouting.planRouteWithLocalModels({
    pilotGate: { releaseChannel: "stable" },
    registry: reg,
    subscriptionFallbacks: [{ provider: "codex-chatgpt-signin", model: "gpt-test" }],
  });
  assert.equal(plan.local, null);
  assert.equal(plan.primary.provider, "codex-chatgpt-signin");
});

test("package metadata declares 0.3.x and marketplace upgrade command remains friend path", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(root, "plugins", "amadeus", ".codex-plugin", "plugin.json"), "utf8"));
  assert.match(pkg.version, /^0\.3\./);
  assert.match(String(plugin.version), /^0\.3\./);
  assert.equal(update.MARKETPLACE_UPGRADE_COMMAND, "codex plugin marketplace upgrade amadeus");
  assert.ok(existsSync(join(root, "docs", "LOCAL_MODEL_PILOT.md")));
  assert.ok(existsSync(join(root, "docs", "UPDATE.md")));
  assert.ok(existsSync(join(root, "docs", "RELEASE_NOTES_0.3.8.md")));
  assert.ok(existsSync(join(root, "docs", "RELEASE_NOTES_0.3.7.md")));
  assert.ok(existsSync(join(root, "docs", "RELEASE_NOTES_0.3.2.md")));
  assert.equal(existsSync(join(root, "docs", "PR_RESTRUCTURE.md")), false);
});

test("work-routing ignores local models when pilot gate closed (stable)", async () => {
  const routingModule = pathToFileURL(join(root, "src", "work-routing.ts")).href;
  // TypeScript may be imported via node with strip types on node 24.
  let selectWorkRoute;
  try {
    ({ selectWorkRoute } = await import(routingModule));
  } catch {
    // Fallback: assert policy via local-model-routing stable helper when TS loader unavailable.
    const status = localRouting.stableChannelLocalRoutingStatus();
    assert.equal(status.localAutomaticRouting, false);
    return;
  }
  const catalog = {
    models: [
      { slug: "gpt-strong", priority: 0, supportedEfforts: ["high", "medium", "low"] },
      { slug: "gpt-work", priority: 1, supportedEfforts: ["medium", "low"] },
      { slug: "gpt-efficient", priority: 2, supportedEfforts: ["low"] },
    ],
  };
  const stable = selectWorkRoute({
    objective: "Summarize the remaining risks briefly",
    cursorInstalled: false,
    catalog,
    localModelPilotGateOpen: false,
    qualifiedLocalModels: [{ providerId: "ollama", model: "llama-test", routable: true }],
  });
  assert.notEqual(stable.provider, "local-openai-compatible");

  const gated = selectWorkRoute({
    objective: "Summarize the remaining risks briefly",
    cursorInstalled: false,
    catalog,
    localModelPilotGateOpen: true,
    qualifiedLocalModels: [{ providerId: "ollama", model: "llama-test", routable: true, endpoint: "http://127.0.0.1:11434/v1" }],
  });
  assert.equal(gated.provider, "local-openai-compatible");
  assert.equal(gated.model, "llama-test");

  const software = selectWorkRoute({
    objective: "run npm test",
    cursorInstalled: true,
    catalog,
    localModelPilotGateOpen: true,
    qualifiedLocalModels: [{ providerId: "ollama", model: "llama-test", routable: true }],
  });
  assert.equal(software.provider, "software");
});

test("the upgrade command and installed version follow the host package", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(update.marketplaceUpgradeCommandFor(join(root, "plugins", "amadeus")), "codex plugin marketplace upgrade amadeus");
  assert.equal(update.marketplaceUpgradeCommandFor(join(root, "claude-plugin")), "claude plugin update amadeus@amadeus");
  const lifecycle = await import(pathToFileURL(join(root, "plugins", "amadeus", "scripts", "amadeus-lifecycle.mjs")).href);
  const codexVersion = lifecycle.readPluginVersion(join(root, "plugins", "amadeus"));
  assert.match(codexVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(lifecycle.readPluginVersion(join(root, "claude-plugin")), codexVersion);
});
