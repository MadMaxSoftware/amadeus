/**
 * Sandbox-friendly runner: loads Amadeus lifecycle modules via data: URLs so
 * Node never realpath()s entry files under a restricted C:\ root. Used when
 * direct `node file.mjs` fails with EPERM on lstat('C:\\').
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import os from "node:os";
import { createRequire } from "node:module";

const root = process.cwd();
const scriptsDir = path.join(root, "plugins", "amadeus", "scripts");
const cache = new Map();

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

async function loadModule(relPath) {
  const absolute = path.join(scriptsDir, relPath);
  if (cache.has(absolute)) return cache.get(absolute);
  let source = fs.readFileSync(absolute, "utf8");
  source = source.replace(
    /from\s+["'](\.\/[^"']+)["']/g,
    (match, spec) => {
      const target = spec.replace(/^\.\//, "");
      // Synchronous placeholder — resolved after preloading below.
      return `from ${JSON.stringify(`__AMADEUS_MOD__:${target}`)}`;
    },
  );
  // First pass: collect deps and preload, then rewrite with real data URLs.
  const deps = [...source.matchAll(/__AMADEUS_MOD__:([^"']+)/g)].map((m) => m[1]);
  for (const dep of deps) await loadModule(dep);
  source = fs.readFileSync(absolute, "utf8").replace(
    /from\s+["']\.\/([^"']+)["']/g,
    (match, spec) => {
      const depAbs = path.join(scriptsDir, spec);
      const depSource = fs.readFileSync(depAbs, "utf8");
      // Nested relative imports inside dependency must already be data-URL rewritten.
      const rewritten = rewriteWithCache(spec, depSource);
      return `from ${JSON.stringify(toDataUrl(rewritten))}`;
    },
  );
  const modPromise = import(toDataUrl(source));
  cache.set(absolute, modPromise);
  return modPromise;
}

const rewriteCache = new Map();
function rewriteWithCache(spec, source) {
  if (rewriteCache.has(spec)) return rewriteCache.get(spec);
  const rewritten = source.replace(
    /from\s+["']\.\/([^"']+)["']/g,
    (match, inner) => {
      const innerSource = fs.readFileSync(path.join(scriptsDir, inner), "utf8");
      const innerRewritten = rewriteWithCache(inner, innerSource);
      return `from ${JSON.stringify(toDataUrl(innerRewritten))}`;
    },
  );
  rewriteCache.set(spec, rewritten);
  return rewritten;
}

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amadeus-lifecycle-"));
}

const update = await loadModule("update-manager.mjs");
const discovery = await loadModule("provider-discovery.mjs");
const registry = await loadModule("provider-registry.mjs");
const qualify = await loadModule("capability-qualification.mjs");
const worker = await loadModule("local-model-worker.mjs");
const localRouting = await loadModule("local-model-routing.mjs");
const lifecycle = await loadModule("amadeus-lifecycle.mjs");
const runtime = await loadModule("amadeus-runtime.mjs");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

await test("semver compare: newer, equal, older, malformed", () => {
  assert.equal(update.compareSemver("0.3.1", "0.3.0"), 1);
  assert.equal(update.compareSemver("0.3.0", "0.3.0"), 0);
  assert.equal(update.compareSemver("0.2.9", "0.3.0"), -1);
  assert.equal(update.classifyUpdate("0.3.0", "0.3.1").kind, "newer");
  assert.equal(update.classifyUpdate("0.3.0", "0.3.0").kind, "equal");
  assert.equal(update.classifyUpdate("0.3.1", "0.3.0").kind, "older");
  assert.equal(update.classifyUpdate("not-a-version", "0.3.0").kind, "malformed");
  assert.throws(() => update.parseSemver("1.2"), /malformed/);
});

await test("update consent + allowed repo", async () => {
  const stateRoot = tempState();
  const paths = update.defaultUpdatePaths(stateRoot);
  update.declineUpdateConsent(paths.consentPath);
  const blocked = await update.checkForUpdate({
    paths,
    currentVersion: "0.3.0",
    fetchLatestRelease: async () => ({ tag_name: "v0.3.1" }),
  });
  assert.equal(blocked.status, "consent-required");
  update.grantUpdateConsent(paths.consentPath);
  assert.throws(() => update.assertAllowedReleaseRepo("evil/other"), (err) => err.code === "DISALLOWED_UPDATE_REPO");
});

await test("update check cases + interval", async () => {
  const stateRoot = tempState();
  const paths = update.defaultUpdatePaths(stateRoot);
  update.grantUpdateConsent(paths.consentPath);
  const now = new Date("2026-10-13T00:00:00.000Z");
  const newer = await update.checkForUpdate({
    paths, currentVersion: "0.3.0", now, force: true,
    fetchLatestRelease: async ({ repo }) => {
      assert.equal(repo, "MadMaxSoftware/amadeus");
      return { tag_name: "v0.3.1", name: "0.3.1", body: "Fixes", published_at: "2026-10-12T00:00:00.000Z", html_url: "https://github.com/MadMaxSoftware/amadeus/releases/tag/v0.3.1" };
    },
  });
  assert.equal(newer.status, "newer");
  assert.equal(newer.hotReplacement, false);
  assert.equal((await update.checkForUpdate({
    paths, currentVersion: "0.3.0", now: new Date("2026-10-13T12:00:00.000Z"),
    fetchLatestRelease: async () => ({ tag_name: "v0.9.0" }),
  })).status, "skipped-interval");
  assert.equal((await update.checkForUpdate({
    paths, currentVersion: "0.3.1", force: true,
    fetchLatestRelease: async () => ({ tag_name: "0.3.1" }),
  })).status, "equal");
  assert.equal((await update.checkForUpdate({
    paths, currentVersion: "0.4.0", force: true,
    fetchLatestRelease: async () => ({ tag_name: "0.3.0" }),
  })).status, "older");
  assert.equal((await update.checkForUpdate({
    paths, currentVersion: "0.3.0", force: true,
    fetchLatestRelease: async () => { throw new Error("network down"); },
  })).status, "unavailable");
  assert.equal((await update.checkForUpdate({
    paths, currentVersion: "0.3.0", force: true,
    fetchLatestRelease: async () => ({ tag_name: "not-semver" }),
  })).status, "malformed");
});

await test("stage/approve/rollback/pending-restart/partial", () => {
  const stateRoot = tempState();
  const paths = update.defaultUpdatePaths(stateRoot);
  const release = { version: "0.3.1", tag: "0.3.1", repo: "MadMaxSoftware/amadeus", name: "0.3.1", body: "notes" };
  assert.equal(update.stageUpdate({ paths, release, files: [{ path: "README.md", content: "hi\n" }] }).status, "partial");
  const pluginJson = JSON.stringify({ name: "amadeus", version: "0.3.1+amadeus.20261013010000" }, null, 2);
  assert.equal(update.stageUpdate({
    paths, release,
    files: [
      { path: "plugins/amadeus/.codex-plugin/plugin.json", content: `${pluginJson}\n` },
      { path: "package.json", content: "{\"version\":\"0.3.1\"}\n" },
    ],
  }).status, "staged");
  assert.equal(update.approveActivation({ paths, approval: false }).status, "approval-required");
  const approved = update.approveActivation({
    paths, approval: true, currentVersion: "0.3.0",
    currentFiles: [{ path: "plugins/amadeus/.codex-plugin/plugin.json", content: "{\"version\":\"0.3.0\"}\n" }],
  });
  assert.equal(approved.status, "pending-restart");
  assert.equal(approved.pendingRestart.hotReplacement, false);
  const rolled = update.rollbackUpdate({ paths, targetDir: path.join(stateRoot, "restored") });
  assert.equal(rolled.status, "rolled-back");
  assert.ok(fs.existsSync(path.join(stateRoot, "restored", "plugins", "amadeus", ".codex-plugin", "plugin.json")));
});

await test("discovery consent/no-LAN/manual", async () => {
  const stateRoot = tempState();
  const paths = discovery.defaultDiscoveryPaths(stateRoot);
  discovery.declineDiscoveryConsent(paths.consentPath);
  assert.equal((await discovery.discoverProviders({
    paths, probe: async () => ({ ok: true, body: { data: [{ id: "x" }] } }),
  })).status, "consent-required");
  discovery.grantDiscoveryConsent(paths.consentPath);
  assert.throws(() => discovery.assertLoopbackOnly("http://192.168.1.10:11434"));
  const report = await discovery.discoverProviders({
    paths, includeKnown: true, manualEndpoints: ["http://127.0.0.1:9999"],
    probe: async ({ url }) => {
      if (url.includes("11434")) return { ok: true, status: 200, body: { models: [{ name: "llama-test" }] } };
      if (url.includes("9999")) return { ok: true, status: 200, body: { data: [{ id: "manual-model" }] } };
      return { ok: false, status: 404, reason: "absent" };
    },
  });
  assert.equal(report.lanScan, false);
  assert.equal(report.routingAuthorityGranted, false);
  assert.ok(report.discovered.some((d) => d.available && d.providerId === "ollama"));
});

await test("registry + qualification gating", async () => {
  let reg = registry.recordDiscovery(registry.emptyRegistry(), {
    discovered: [{
      providerId: "ollama", kind: "ollama",
      endpoint: "http://127.0.0.1:11434/api/tags",
      openaiEndpoint: "http://127.0.0.1:11434/v1/models",
      available: true, models: [{ id: "llama-test" }], routingAuthority: true, source: "known-loopback-default",
    }],
  });
  assert.equal(reg.providers.ollama.routingAuthority, false);
  reg = registry.approveProvider(reg, "ollama", true);
  reg = registry.enableProvider(reg, "ollama", true);
  const qualification = await qualify.qualifyProvider({
    provider: reg.providers.ollama,
    probeModel: async () => ({ ok: true, latencyMs: 120, output: { choices: [{ message: { content: "ok" } }] } }),
  });
  assert.equal(qualification.status, "qualified");
  reg = registry.setProviderQualification(reg, "ollama", qualification);
  assert.equal(registry.listRoutableProviders(reg, { requirePilotGate: true, pilotGateOpen: false }).length, 0);
  assert.equal(registry.listRoutableProviders(reg, { requirePilotGate: true, pilotGateOpen: true }).length, 1);
  assert.equal((await qualify.qualifyProvider({
    provider: { ...reg.providers.ollama, models: [{ id: "m1" }] },
    probeModel: async () => ({ ok: true, latencyMs: 60_000, output: { choices: [{ message: { content: "x" } }] } }),
  })).status, "slow");
  assert.equal((await qualify.qualifyProvider({
    provider: { id: "ollama", approved: true, enabled: true, models: [{ id: "m1" }] },
    probeModel: async () => ({ disappeared: true }),
  })).status, "disappeared");
});

await test("pilot gate + isolation + stable routing off", async () => {
  assert.equal(worker.isLocalModelPilotGateOpen({ releaseChannel: "stable", experimentalEnabled: true, friendPilotPassed: true }), false);
  assert.equal(worker.isLocalModelPilotGateOpen({ releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true }), true);
  const config = worker.createIsolatedWorkerConfig({ endpoint: "http://127.0.0.1:11434/v1" });
  assert.equal(config.networkPolicy, "loopback-only");
  assert.throws(() => worker.createIsolatedWorkerConfig({ endpoint: "http://192.168.0.5:11434/v1" }));
  assert.equal((await worker.runIsolatedLocalCompletion({
    endpoint: "http://127.0.0.1:11434/v1", model: "llama-test",
    pilotGate: { releaseChannel: "stable" },
    transport: async () => ({ ok: true, output: { choices: [{ message: { content: "hi" } }] } }),
  })).status, "pilot-gate-closed");
  assert.equal(localRouting.stableChannelLocalRoutingStatus().localAutomaticRouting, false);
  assert.equal(localRouting.selectQualifiedLocalRoute({
    pilotGate: { releaseChannel: "stable" },
    candidates: [{ id: "ollama", approved: true, enabled: true, models: [{ id: "m1" }], qualification: { status: "qualified", routable: true, qualifiedModelIds: ["m1"] } }],
  }).route, null);
  const open = localRouting.selectQualifiedLocalRoute({
    pilotGate: { releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true },
    candidates: [{
      id: "ollama", approved: true, enabled: true, openaiEndpoint: "http://127.0.0.1:11434/v1",
      models: [{ id: "m1" }],
      qualification: { status: "qualified", routable: true, qualifiedModelIds: ["m1"], models: [{ status: "qualified", latencyMs: 50 }] },
    }],
  });
  assert.equal(open.route.provider, "local-openai-compatible");
  assert.equal(localRouting.planRouteWithLocalModels({
    softwareRoute: { provider: "software", model: null },
    pilotGate: { releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true },
  }).primary.provider, "software");
});

await test("config migration + startup lifecycle", async () => {
  const stateRoot = tempState();
  const migrated = runtime.migrateMachineConfig({ schemaVersion: 1, setupRoot: stateRoot, stateRoot });
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.runtimeAuthority, "packaged");
  assert.equal(migrated.consents.updateChecks, false);
  const boot = await lifecycle.runStartupLifecycle({ stateRoot, currentVersion: "0.3.0" });
  assert.equal(boot.updates.status, "consent-required");
  assert.equal(boot.localRouting.localAutomaticRouting, false);
});

await test("package metadata 0.3.x + pilot doc", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugins", "amadeus", ".codex-plugin", "plugin.json"), "utf8"));
  assert.match(pkg.version, /^0\.3\./);
  assert.match(String(plugin.version), /^0\.3\./);
  assert.ok(fs.existsSync(path.join(root, "docs", "LOCAL_MODEL_PILOT.md")));
  assert.ok(fs.existsSync(path.join(root, "docs", "RELEASE_NOTES_0.3.8.md")));
  assert.ok(fs.existsSync(path.join(root, "docs", "RELEASE_NOTES_0.3.7.md")));
  assert.ok(fs.existsSync(path.join(root, "docs", "RELEASE_NOTES_0.3.2.md")));
  assert.equal(fs.existsSync(path.join(root, "docs", "PR_RESTRUCTURE.md")), false);
  assert.equal(update.MARKETPLACE_UPGRADE_COMMAND, "codex plugin marketplace upgrade amadeus");
});

await test("work-routing gate via local helper policy", async () => {
  // Direct TS import may be unavailable in sandbox; assert policy surface.
  assert.equal(localRouting.stableChannelLocalRoutingStatus().pilotGateOpen, false);
  const open = localRouting.selectQualifiedLocalRoute({
    pilotGate: { releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true },
    candidates: [{
      id: "ollama", approved: true, enabled: true, models: [{ id: "m1" }],
      qualification: { status: "qualified", routable: true, qualifiedModelIds: ["m1"], models: [{ status: "qualified", latencyMs: 1 }] },
    }],
  });
  assert.equal(open.route.model, "m1");
});

console.log(`\n# pass ${passed} fail ${failed}`);
if (failed > 0) process.exitCode = 1;
else process.exitCode = 0;

// Keep createRequire referenced for future CJS bridges in this sandbox runner.
void createRequire;
