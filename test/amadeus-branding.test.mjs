import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const amadeusRoot = join(workerRoot, "plugins", "amadeus");
const runtimeUrl = pathToFileURL(join(amadeusRoot, "scripts", "amadeus-runtime.mjs")).href;

const {
  AMADEUS_PRODUCT,
  buildProductionPaths,
  resolveCoordinatorLayout,
  writeMachineConfig,
  loadMachineConfig,
  assertNoPersonalLeak,
  PRIVACY_BANNED_PATTERNS,
} = await import(runtimeUrl);

function read(path) {
  return readFileSync(path, "utf8");
}

function skillMatches(description, utterance) {
  const stop = new Set(["a", "an", "the", "to", "for", "or", "and", "of", "in", "on", "with", "by", "is", "are", "do", "not"]);
  const hayWords = new Set(description.toLowerCase().split(/\W+/).filter((w) => w && !stop.has(w)));
  const words = utterance.toLowerCase().split(/\W+/).filter((w) => w && !stop.has(w));
  if (!words.length) return false;
  const hits = words.filter((word) => hayWords.has(word));
  return hits.length >= Math.max(2, Math.ceil(words.length / 2));
}


test("plugin metadata presents Amadeus by Mad Max Systems", () => {
  const plugin = JSON.parse(read(join(amadeusRoot, ".codex-plugin", "plugin.json")));
  assert.equal(plugin.name, "amadeus");
  assert.equal(plugin.interface.displayName, "Amadeus");
  assert.equal(plugin.interface.shortDescription, "Local AI Orchestrator");
  assert.equal(plugin.author.name, "Mad Max Systems");
  assert.equal(plugin.interface.developerName, "Mad Max Systems");
  assert.match(plugin.description, /Local AI Orchestrator/);
  assertNoPersonalLeak(JSON.stringify(plugin), "plugin manifest");
});

test("marketplace installs Amadeus from the public plugin path", () => {
  const market = JSON.parse(read(join(workerRoot, ".agents", "plugins", "marketplace.json")));
  assert.equal(market.name, "amadeus");
  assert.equal(market.plugins[0].name, "amadeus");
  assert.equal(market.plugins[0].source.path, "./plugins/amadeus");
  assert.equal(market.plugins[0].policy.installation, "INSTALLED_BY_DEFAULT");
});

test("MCP uses the Amadeus server id and portable node command", () => {
  const mcp = JSON.parse(read(join(amadeusRoot, ".mcp.json")));
  assert.equal(Object.keys(mcp.mcpServers)[0], AMADEUS_PRODUCT.internalMcpServerId);
  assert.equal(mcp.mcpServers.amadeus.command, "node");
  assert.doesNotMatch(mcp.mcpServers.amadeus.command, /Program Files/i);
  assertNoPersonalLeak(JSON.stringify(mcp), "MCP config");
});

test("Amadeus and Maestro skills are implicitly invocable with specific matching", () => {
  const amadeusSkill = read(join(amadeusRoot, "skills", "amadeus", "SKILL.md"));
  const maestroSkill = read(join(amadeusRoot, "skills", "maestro", "SKILL.md"));
  const amadeusYaml = read(join(amadeusRoot, "skills", "amadeus", "agents", "openai.yaml"));
  const maestroYaml = read(join(amadeusRoot, "skills", "maestro", "agents", "openai.yaml"));

  assert.match(amadeusSkill, /^name:\s*amadeus/m);
  assert.match(maestroSkill, /^name:\s*maestro/m);
  assertNoPersonalLeak(amadeusSkill + maestroSkill, "skills");
  assert.match(amadeusYaml, /allow_implicit_invocation:\s*true/);
  assert.match(maestroYaml, /allow_implicit_invocation:\s*true/);
  const publicSkillNames = ["amadeus", "maestro"];
  assert.equal(publicSkillNames.every((name) => existsSync(join(amadeusRoot, "skills", name))), true);

  const amadeusDesc = amadeusSkill.match(/^description:\s*(.+)$/m)[1];
  const maestroDesc = maestroSkill.match(/^description:\s*(.+)$/m)[1];
  assert.equal(skillMatches(amadeusDesc, "Amadeus continue durable local development orchestration"), true);
  assert.equal(skillMatches(maestroDesc, "Maestro alias Amadeus orchestration"), true);
  assert.equal(skillMatches(amadeusDesc, "what's the weather in Paris today"), false);
  assert.equal(skillMatches(maestroDesc, "tell me a joke about cats"), false);
});

test("Maestro aliases the Amadeus owner contract without a separate voice", () => {
  const amadeus = read(join(amadeusRoot, "skills", "amadeus", "SKILL.md"));
  const maestro = read(join(amadeusRoot, "skills", "maestro", "SKILL.md"));
  assert.match(amadeus, /For a new task,/);
  assert.match(amadeus, /For a setback,/);
  assert.match(amadeus, /For a finished task,/);
  assert.match(amadeus, /owner action/i);
  assert.match(amadeus, /curious, practical voice/);
  assert.match(amadeus, /promising approach/);
  assert.match(maestro, /alias for/);
  assert.match(maestro, /same behavior, instructions, engine, and tools/);
  assert.match(amadeus, /Do not invent progress/);
  assert.match(maestro, /without changing voice,/);
  assert.match(maestro, /Follow the Amadeus owner contract and workflow/);
  assert.doesNotMatch(maestro, /own coordinator|separate engine|different routing/i);
});

test("portable machine config keeps durable state while packaged runtime stays authoritative", () => {
  const temp = mkdtempSync(join(tmpdir(), "amadeus-config-"));
  const fakeSetup = join(temp, "setup");
  const coordinator = join(fakeSetup, "coordinator", "src");
  mkdirSync(coordinator, { recursive: true });
  writeFileSync(join(coordinator, "coordinator.ts"), "export {}\n");
  const configPath = join(temp, "config.json");
  const stateRoot = join(temp, "state");
  writeMachineConfig({ setupRoot: fakeSetup, stateRoot }, configPath);
  const loaded = loadMachineConfig(configPath);
  assert.equal(loaded.setupRoot, fakeSetup);
  assert.equal(loaded.stateRoot, stateRoot);
  assert.equal(loaded.publisher, "Mad Max Systems");
  assert.equal(loaded.runtimeAuthority, "packaged");
  assert.equal(loaded.developerMode, false);

  // Stale persisted setupRoot must not select executable code.
  const layout = resolveCoordinatorLayout({
    configPath,
    metaUrl: pathToFileURL(join(amadeusRoot, "scripts", "amadeus-runtime.mjs")).href,
  });
  assert.equal(layout.packaged, true);
  assert.equal(layout.authority, "packaged-runtime");
  assert.notEqual(layout.setupRoot, fakeSetup);
  const paths = buildProductionPaths({
    configPath,
    metaUrl: pathToFileURL(join(amadeusRoot, "scripts", "amadeus-runtime.mjs")).href,
  });
  assert.equal(paths.database, join(stateRoot, "coordinator.sqlite"));
  assert.equal(paths.runtimePackaged, true);
  assert.ok(paths.database.includes("state"));
});

test("privacy scan patterns reject personal leaks", () => {
  const previous = process.env.AMADEUS_PRIVATE_TERMS_FILE;
  const dir = mkdtempSync(join(tmpdir(), "amadeus-private-terms-"));
  const termsFile = join(dir, "terms.json");
  writeFileSync(termsFile, JSON.stringify(["Example Private Project"]));
  process.env.AMADEUS_PRIVATE_TERMS_FILE = termsFile;
  try {
    assertNoPersonalLeak("an ordinary public sentence", "sample");
    assert.throws(() => assertNoPersonalLeak("see example-private_project notes", "sample"));
    assert.throws(() => assertNoPersonalLeak("C:/Program Files/nodejs/node.exe", "sample"));
  } finally {
    if (previous === undefined) delete process.env.AMADEUS_PRIVATE_TERMS_FILE; else process.env.AMADEUS_PRIVATE_TERMS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(PRIVACY_BANNED_PATTERNS.length >= 1);
});

test("package.json and marketplace version metadata stay consistent", () => {
  const pkg = JSON.parse(read(join(workerRoot, "package.json")));
  const plugin = JSON.parse(read(join(amadeusRoot, ".codex-plugin", "plugin.json")));
  assert.equal(pkg.name, "amadeus-local-ai-orchestrator");
  assert.match(pkg.description, /Amadeus/);
  assert.match(pkg.description, /Mad Max Systems/);
  assert.equal(pkg.version.split(".")[0], plugin.version.split(".")[0]);
  assert.equal(pkg.version.split(".")[1], plugin.version.split(".")[1]);
});

test("startup permission wording is plain language for end users", () => {
  const hooks = JSON.parse(read(join(amadeusRoot, "hooks", "hooks.json")));
  const handler = hooks.hooks.SessionStart[0].hooks[0];
  assert.equal(handler.statusMessage, "Start Amadeus automatically");
  assert.equal(
    hooks.description,
    "Amadeus becomes available in new chats for longer-task coordination, runs locally at startup, and does not scan the computer or send personal information.",
  );
  assert.doesNotMatch(hooks.description, /SessionStart|coordination context|runtime|\bscript\b/i);
  assert.doesNotMatch(handler.statusMessage, /SessionStart|coordination context|runtime|\bscript\b|\bhook\b/i);
  assert.doesNotMatch(JSON.stringify(hooks), /Loading Amadeus coordination context/);

  const setupSkill = read(join(amadeusRoot, "skills", "setup", "SKILL.md"));
  assert.match(setupSkill, /Start Amadeus automatically/);
  assert.doesNotMatch(setupSkill, /SessionStart|\bhooks?\b|coordination context|\bruntime\b|\bscript\b/i);

  const onboarding = read(join(workerRoot, "docs", "ONBOARDING.md"));
  const install = read(join(workerRoot, "docs", "INSTALL.md"));
  const readme = read(join(workerRoot, "README.md"));
  for (const text of [onboarding, install, readme]) {
    assert.match(text, /Start Amadeus automatically/);
  }
  const userFacingOnboarding = onboarding.replace(/Maintainer note:[\s\S]*$/, "");
  assert.doesNotMatch(userFacingOnboarding, /SessionStart|coordination context|\bscript\b/i);
  assert.doesNotMatch(install, /SessionStart|coordination context/i);
  assert.doesNotMatch(readme, /SessionStart|coordination context/i);
});
