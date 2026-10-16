import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultMachineConfigPath, loadMachineConfig, resolveStateRoot, buildProductionPaths, missingDependencyReport, pluginRootFrom, writeMachineConfig } from "./amadeus-runtime.mjs";
import { DISCOVERY_DISCLOSURE, DISCOVERY_DISCLOSURE_VERSION, DISCOVERY_SCOPES,
  defaultDiscoveryPaths, defaultDiscoveryConsent, loadDiscoveryJson, hasDiscoveryConsent,
  grantDiscoveryConsent, declineDiscoveryConsent } from "./provider-discovery.mjs";

export function onboardingStatus(options = {}) {
  const configPath = options.configPath ?? defaultMachineConfigPath();
  const config = loadMachineConfig(configPath);
  const stateRoot = options.stateRoot ?? resolveStateRoot({ configPath });
  const consentPath = defaultDiscoveryPaths(stateRoot).consentPath;
  const consent = loadDiscoveryJson(consentPath, defaultDiscoveryConsent());
  const granted = DISCOVERY_SCOPES.every((scope) => hasDiscoveryConsent(consent, scope));
  const allowedScopes = DISCOVERY_SCOPES.filter(scope => hasDiscoveryConsent(consent, scope));
  const declined = consent?.discovery === false && Number.isFinite(Date.parse(consent.declinedAt));
  let runtimeConfigured = false, state = "unavailable", missing = [];
  try {
    const paths = buildProductionPaths({ ...options, configPath, stateRoot, metaUrl: options.metaUrl ?? import.meta.url });
    const report = missingDependencyReport(paths);
    runtimeConfigured = true; missing = report.missing;
    state = report.ok ? "ready" : "setup incomplete";
    const manifestPath = join(paths.coordinatorRoot, 'manifest.json');
    if (paths.runtimePackaged && !existsSync(manifestPath)) throw new Error('Missing runtime manifest');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const [file, expected] of Object.entries(manifest)) {
        if (!/^(?:src\/[a-zA-Z0-9_.-]+|config-templates\/[a-zA-Z0-9_.-]+|package.json)$/.test(file)) throw new Error('Invalid runtime manifest');
        const content = readFileSync(join(paths.coordinatorRoot, file), 'utf8').replaceAll('\r\n', '\n');
        if (createHash('sha256').update(content).digest('hex') !== expected) throw new Error('Damaged runtime');
      }
    }
    if (state === 'ready') {
      try {
        const operations = JSON.parse(readFileSync(paths.operations, 'utf8'));
        const worker = JSON.parse(readFileSync(paths.workerConfig, 'utf8'));
        if (!operations.dispatch || typeof worker.executable !== 'string') state = 'setup incomplete';
      } catch { state = 'setup incomplete'; }
    }
    if (Number(process.versions.node.split('.')[0]) < 24) state = 'unavailable';
  } catch { state = 'unavailable'; runtimeConfigured = false; /* Choices remain available without the backend. */ }
  return {
    ok: true, state, missing,
    reporting: {
      available: false,
      enabled: false,
      status: "deferred",
      transmissionStarted: false,
      note: "Private reporting and developer intake are not part of the release path.",
    },
    hookTrust: "host-controlled; verify in a fresh chat", runtimeConfigured, configPresent: Boolean(config), configPath, stateRoot,
    consentPath, consentRecorded: existsSync(consentPath),
    discoveryConsent: granted ? "granted" : allowedScopes.length ? "partially-granted" : declined ? "declined" : "not-granted",
    allowedScopes,
    onboardingRequired: !allowedScopes.length && !declined,
    disclosureVersion: DISCOVERY_DISCLOSURE_VERSION, disclosure: DISCOVERY_DISCLOSURE,
    scopes: DISCOVERY_SCOPES, collectionStarted: false,
    question: !allowedScopes.length && !declined
      ? "Allow optional capability discovery later, or keep it disabled? No scan starts with this choice."
      : null,
    choices: ["Keep disabled", "Allow later discovery"],
    nextAction: !allowedScopes.length && !declined ? "show_disclosure_and_ask_owner" : "none",
    runtimeGuidance: state === 'ready' ? null : state === 'setup incomplete' ? 'Run the packaged setup workflow to complete runtime configuration.' : 'The bundled runtime is unavailable or damaged. Privacy choices remain available; review a package repair or reinstall before coordinating work.',
  };
}

export function recordDiscoveryChoice(args, options = {}) {
  if (typeof args?.consent !== "boolean") throw new Error("An explicit true/false owner choice is required.");
  if (args.consent && args.disclosureVersion !== DISCOVERY_DISCLOSURE_VERSION) {
    throw new Error("Show the current onboarding disclosure and obtain the owner's explicit choice first.");
  }
  const status = onboardingStatus(options);
  if (args.consent) grantDiscoveryConsent(status.consentPath, new Date(), args.scopes ?? DISCOVERY_SCOPES);
  else declineDiscoveryConsent(status.consentPath);
  return { ...onboardingStatus(options), collectionStarted: false };
}

export function configureRuntime(args, options = {}) {
  const before = onboardingStatus(options);
  const previousConfig = loadMachineConfig(before.configPath);
  // Preserve the consent location when configuring after first-run privacy setup.
  const stateRoot = args.stateRoot ?? before.stateRoot;
  const developerMode = args?.developerMode === true;
  if (developerMode) {
    if (typeof args?.setupRoot !== "string" || !args.setupRoot.trim()) {
      throw new Error("Developer mode requires an explicit authoritative Amadeus setupRoot.");
    }
    const paths = buildProductionPaths({
      setupRoot: args.setupRoot,
      stateRoot,
      configPath: before.configPath,
      developerMode: true,
      metaUrl: options.metaUrl ?? import.meta.url,
    });
    writeMachineConfig({
      setupRoot: paths.setupRoot,
      stateRoot,
      developerMode: true,
      runtimeAuthority: "developer-source",
    }, before.configPath);
    return onboardingStatus({ ...options, stateRoot });
  }
  // Public path: packaged runtime is authoritative; setupRoot never selects code.
  const paths = buildProductionPaths({
    stateRoot,
    configPath: before.configPath,
    metaUrl: options.metaUrl ?? import.meta.url,
  });
  writeMachineConfig({
    stateRoot: paths.stateRoot,
    developerMode: false,
    runtimeAuthority: "packaged",
    // Retain only as a non-authoritative migration hint when callers pass one.
    legacySetupRootHint: typeof args?.setupRoot === "string" && args.setupRoot.trim()
      ? args.setupRoot
      : previousConfig?.legacySetupRootHint ?? previousConfig?.setupRoot,
  }, before.configPath);
  return onboardingStatus({ ...options, stateRoot: paths.stateRoot });
}

export const onboardingInstructions = "Amadeus is the default coordinator for substantive local work; keep simple conversation lightweight and honour per-task bypass. Call amadeus_onboarding_status before substantive work and use the setup skill if needed. Public installs execute the packaged runtime; persisted setupRoot values are not executable authority. Routine known dependency checks do not need inventory consent. Optional discovery and update checks are separate choices; declining them never blocks ordinary coordination. Consent alone never starts collection. Follow user instructions not to scan. Do not silently repair installed plugins or mutate foreign host trees; preserve local reviewable repair artifacts and use reviewed Amadeus source changes under explicit developer mode instead.";

export function onboardingToolDefinitions() {
  return [
    { name: "amadeus_setup", description: "Seed missing runtime configuration from packaged defaults, preserving existing goals and choices. No inventory or remote checks.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "amadeus_onboarding_status", description: "Read first-run privacy disclosure and saved choices without scanning, writing, or requiring the coordinator.",
      annotations: { readOnlyHint: true }, inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "amadeus_configure_runtime", description: "Configure Amadeus durable state and packaged runtime without discovery or changing consent. Optional setupRoot is a migration hint only unless developerMode is explicitly enabled.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        setupRoot: { type: "string" }, stateRoot: { type: "string" }, developerMode: { type: "boolean" } } } },
    { name: "amadeus_dependency_health", description: "Quiet narrow checks for known Node, Git, Codex and optional Cursor dependencies. Independent of inventory consent.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  ];
}

function readJsonObject(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isExistingAbsoluteFile(path) {
  try { return typeof path === "string" && isAbsolute(path) && statSync(path).isFile(); } catch { return false; }
}

function isExistingAbsoluteDirectory(path) {
  try { return typeof path === "string" && isAbsolute(path) && statSync(path).isDirectory(); } catch { return false; }
}

/**
 * A migration candidate must contain the reviewed browser-login containment
 * boundary, not merely claim that Cursor is enabled. This prevents setup from
 * promoting the privacy-clean template or a stale partial config into routing.
 */
function isStrictChild(parent, candidate) {
  if (typeof parent !== "string" || typeof candidate !== "string" || !isAbsolute(parent) || !isAbsolute(candidate)) return false;
  const value = relative(resolve(parent), resolve(candidate));
  return Boolean(value) && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function isRecoverableCursorConfig(config) {
  return config?.schemaVersion === 1
    && config.authentication === "browser-login"
    && config.apiKeyAuthenticationAllowed === false
    && config.automaticStartup === false
    && config.spendingRouteReviewed === true
    && isExistingAbsoluteFile(config.executable)
    && Array.isArray(config.executableArguments)
    && isExistingAbsoluteFile(config.containmentExecutable)
    && config.containmentProfile === "cursor_contained"
    && config.containmentWindowsSandbox === "mxc"
    && typeof config.containedUsername === "string"
    && Boolean(config.containedUsername.trim())
    && isExistingAbsoluteDirectory(config.configurationDirectory)
    && Array.isArray(config.readableProjectRoots)
    && config.readableProjectRoots.length > 0
    && config.readableProjectRoots.every(isExistingAbsoluteDirectory)
    && Array.isArray(config.deniedParentPaths)
    && Array.isArray(config.protectedPaths)
    && Array.isArray(config.writableWorkspacePaths);
}

export function isMigratableCursorConfig(config) {
  return isRecoverableCursorConfig(config)
    && isExistingAbsoluteDirectory(config.containedAppData)
    && isExistingAbsoluteDirectory(config.containedUserProfile)
    && isExistingAbsoluteFile(config.userInfoShim)
    && isExistingAbsoluteFile(config.pathVerifierShim)
    && isExistingAbsoluteDirectory(config.runtimeConfigurationRoot)
    && isStrictChild(config.containedAppData, config.runtimeConfigurationRoot)
    && isExistingAbsoluteFile(config.isolationAcceptanceHarness)
    && isExistingAbsoluteFile(config.isolationSecurityStateProbe);
}

function jsonEquivalent(left, right) {
  return left !== null && right !== null && isDeepStrictEqual(left, right);
}

function cursorMigrationSource(legacySetupRootHint) {
  if (typeof legacySetupRootHint !== "string" || !legacySetupRootHint.trim()) return null;
  const candidates = [
    join(legacySetupRootHint, "cursor-worker-config.json"),
    join(legacySetupRootHint, "coordinator", "cursor-worker-config.json"),
    join(legacySetupRootHint, "runtime-config", "cursor-worker-config.json"),
  ];
  return candidates.find((candidate) => isRecoverableCursorConfig(readJsonObject(candidate))) ?? null;
}

function packagedCursorProtectedPaths(config, stateRoot, cursorStateRoot) {
  const cursorKey = resolve(cursorStateRoot).toLowerCase();
  const inherited = config.protectedPaths.filter((path) => {
    if (typeof path !== "string" || !isAbsolute(path)) return true;
    const protectedKey = resolve(path).toLowerCase();
    return cursorKey !== protectedKey && !cursorKey.startsWith(`${protectedKey}${sep}`);
  });
  // A legacy config protected the whole Amadeus state root. That also denied
  // Cursor's dedicated AppData/runtime subtree, so a more-specific write could
  // not be granted by MXC. Preserve the sensitive coordinator areas explicitly
  // and leave only the dedicated Cursor provider subtree available.
  const coordinatorPaths = [
    "runtime-config", "goal-packages", "goal-runs", "active-goal-runs", "patches",
    "project-checkpoints", "reconciliation-backups", "repair-artifacts",
    "retired-goal-run-locks", "updates", "preferences.json", "worker-source-manifest.json",
    "coordinator.sqlite", "coordinator.sqlite-shm", "coordinator.sqlite-wal",
    join("providers", "codex"), join("providers", "claude"),
  ].map((path) => join(stateRoot, path));
  return [...new Map([...inherited, ...coordinatorPaths].map((path) => [resolve(path).toLowerCase(), resolve(path)])).values()];
}

function withPackagedCursorIsolationTools(config, pluginRoot, stateRoot) {
  if (!isRecoverableCursorConfig(config)) return config;
  const cursorStateRoot = join(stateRoot, "providers", "cursor");
  const containedAppData = join(cursorStateRoot, "appdata");
  const containedUserProfile = join(cursorStateRoot, "profile");
  const runtimeConfigurationRoot = join(containedAppData, "runtime");
  const authenticationFile = isExistingAbsoluteFile(config.authenticationFile)
    ? config.authenticationFile
    : join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? dirname(stateRoot), "AppData", "Roaming"), "Cursor", "auth.json");
  for (const directory of [containedAppData, containedUserProfile, runtimeConfigurationRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    ...config,
    containedAppData,
    containedUserProfile,
    userInfoShim: join(pluginRoot, "runtime", "src", "cursor-windows-userinfo-shim.cjs"),
    pathVerifierShim: join(pluginRoot, "runtime", "src", "cursor-path-verifier-shim.cjs"),
    authenticationFile,
    protectedPaths: packagedCursorProtectedPaths(config, stateRoot, cursorStateRoot),
    runtimeConfigurationRoot,
    isolationAcceptanceHarness: join(pluginRoot, "runtime", "src", "cursor-project-scope-acceptance.mjs"),
    isolationSecurityStateProbe: join(pluginRoot, "runtime", "src", "isolation-security-state.ps1"),
  };
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function knownClaudeExecutable(options = {}) {
  if (isExistingAbsoluteFile(options.claudeExecutable)) return resolve(options.claudeExecutable);
  const env = options.env ?? process.env;
  const profile = env.USERPROFILE;
  const roaming = env.APPDATA ?? (profile ? join(profile, "AppData", "Roaming") : null);
  if (!roaming) return null;
  const candidate = join(roaming, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return isExistingAbsoluteFile(candidate) ? candidate : null;
}

function stagedClaudeExecutable(source, options = {}) {
  if (!source || process.platform !== "win32") return source;
  const packagePath = join(dirname(dirname(source)), "package.json");
  const packageJson = readJsonObject(packagePath);
  const version = typeof packageJson?.version === "string" && /^[0-9A-Za-z._-]+$/.test(packageJson.version)
    ? packageJson.version : fileSha256(source).slice(0, 16);
  const profile = (options.env ?? process.env).USERPROFILE;
  if (!profile) throw new Error("Claude staging requires USERPROFILE");
  const destination = join(options.softwareRuntimeRoot ?? join(profile, ".amadeus", "software-runtime-homes"),
    "claude-code", version, "claude.exe");
  mkdirSync(dirname(destination), { recursive: true });
  if (!existsSync(destination) || fileSha256(destination) !== fileSha256(source)) copyFileSync(source, destination);
  if (fileSha256(destination) !== fileSha256(source)) throw new Error("Staged Claude executable hash mismatch");
  return destination;
}

function withPackagedClaudeIsolationTools(config, cursorConfig, pluginRoot, stateRoot, options = {}) {
  const shouldEnable = options.enableClaude === true || config?.enabled === true;
  const sourceExecutable = knownClaudeExecutable(options);
  const executable = shouldEnable && sourceExecutable ? stagedClaudeExecutable(sourceExecutable, options) : sourceExecutable;
  const profile = (options.env ?? process.env).USERPROFILE;
  const configurationDirectory = isExistingAbsoluteDirectory(config?.configurationDirectory)
    ? resolve(config.configurationDirectory) : profile ? join(profile, ".claude") : null;
  const claudeStateRoot = join(stateRoot, "providers", "claude");
  const containedAppData = join(claudeStateRoot, "appdata");
  const containedUserProfile = join(claudeStateRoot, "profile");
  const runtimeConfigurationRoot = join(containedAppData, "runtime");
  for (const directory of [containedAppData, containedUserProfile, runtimeConfigurationRoot]) mkdirSync(directory, { recursive: true });
  const boundaryReady = executable && isExistingAbsoluteDirectory(configurationDirectory)
    && isExistingAbsoluteFile(cursorConfig?.containmentExecutable)
    && Array.isArray(cursorConfig?.readableProjectRoots) && cursorConfig.readableProjectRoots.length > 0;
  const enabled = Boolean(shouldEnable && boundaryReady);
  return {
    ...config,
    enabled,
    dispatchAuthorized: enabled,
    implementationPrepared: enabled,
    implementationDispatchAuthorized: enabled,
    automaticStartup: false,
    executable: executable ?? config?.executable ?? null,
    executableArguments: [],
    containmentExecutable: cursorConfig?.containmentExecutable ?? config?.containmentExecutable ?? null,
    containmentProfile: "claude_contained",
    containmentWindowsSandbox: "mxc",
    containedAppData,
    containedUsername: cursorConfig?.containedUsername ?? config?.containedUsername ?? null,
    containedUserProfile,
    userInfoShim: join(pluginRoot, "runtime", "src", "claude-windows-userinfo-shim.cjs"),
    pathVerifierShim: join(pluginRoot, "runtime", "src", "claude-path-verifier-shim.cjs"),
    authentication: "subscription-signin",
    apiKeyAuthenticationAllowed: false,
    spendingRouteReviewed: true,
    readOnlyOnly: !enabled,
    deniedSourceRoot: cursorConfig?.deniedSourceRoot ?? config?.deniedSourceRoot ?? null,
    assignedProjectRoot: cursorConfig?.assignedProjectRoot ?? config?.assignedProjectRoot ?? null,
    readableProjectRoots: cursorConfig?.readableProjectRoots ?? config?.readableProjectRoots ?? [],
    deniedParentPaths: cursorConfig?.deniedParentPaths ?? config?.deniedParentPaths ?? [],
    protectedPaths: cursorConfig?.protectedPaths ?? config?.protectedPaths ?? [],
    configurationDirectory,
    runtimeConfigurationRoot,
    writableWorkspacePaths: cursorConfig?.writableWorkspacePaths ?? config?.writableWorkspacePaths ?? [],
    isolationAcceptanceHarness: join(pluginRoot, "runtime", "src", "claude-project-scope-acceptance.mjs"),
    isolationSecurityStateProbe: join(pluginRoot, "runtime", "src", "isolation-security-state.ps1"),
    readIsolationVerified: false,
    readIsolationReceipt: null,
    writeIsolationVerified: false,
    writeIsolationReceipt: null,
  };
}

export function setupPackagedRuntime(options = {}) {
  const configPath = options.configPath ?? defaultMachineConfigPath();
  const previousMachineConfig = loadMachineConfig(configPath);
  const legacySetupRootHint = options.legacySetupRootHint
    ?? previousMachineConfig?.legacySetupRootHint
    ?? previousMachineConfig?.setupRoot;
  const paths = buildProductionPaths({
    ...options,
    configPath,
    metaUrl: options.metaUrl ?? import.meta.url,
  });
  // An unchanged packaged machine configuration may contain owner extensions.
  // Seeding optional adapters must not rewrite that configuration on every run.
  if (!previousMachineConfig || previousMachineConfig.runtimeAuthority !== "packaged"
    || previousMachineConfig.developerMode !== false || previousMachineConfig.stateRoot !== paths.stateRoot
    || previousMachineConfig.legacySetupRootHint !== legacySetupRootHint) {
    writeMachineConfig({
      stateRoot: paths.stateRoot,
      developerMode: false,
      runtimeAuthority: "packaged",
      legacySetupRootHint,
    }, configPath);
  }
  const pluginRoot = pluginRootFrom(options.metaUrl ?? import.meta.url);
  const templateRoot = join(pluginRoot, "runtime", "config-templates");
  for (const [name, destination] of [["operations-review.json", paths.operations], ["worker-config.json", paths.workerConfig], ["cursor-worker-config.json", paths.cursorWorkerConfig]]) {
    const template = join(templateRoot, name);
    if (name !== "cursor-worker-config.json") {
      if (!existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(template, destination);
      }
      continue;
    }
    const migrationSource = cursorMigrationSource(legacySetupRootHint);
    const destinationConfig = readJsonObject(destination);
    const destinationIsTemplate = jsonEquivalent(destinationConfig, readJsonObject(template));
    if (!existsSync(destination) || destinationIsTemplate && migrationSource) {
      mkdirSync(dirname(destination), { recursive: true });
      const source = readJsonObject(migrationSource ?? template);
      const migrated = withPackagedCursorIsolationTools(source, pluginRoot, paths.stateRoot);
      writeFileSync(destination, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    } else if (isRecoverableCursorConfig(destinationConfig)) {
      // Keep all owner-edited host bindings, but replace project-specific
      // legacy acceptance helpers with the packaged generic implementations.
      const upgraded = withPackagedCursorIsolationTools(destinationConfig, pluginRoot, paths.stateRoot);
      if (!jsonEquivalent(destinationConfig, upgraded)) {
        writeFileSync(destination, `${JSON.stringify(upgraded, null, 2)}\n`, "utf8");
      }
    }
  }
  const claudeTemplate = join(templateRoot, "claude-worker-config.json");
  const existingClaude = readJsonObject(paths.claudeWorkerConfig) ?? readJsonObject(claudeTemplate);
  const installedCursor = readJsonObject(paths.cursorWorkerConfig);
  if (existingClaude) {
    const configuredClaude = withPackagedClaudeIsolationTools(existingClaude, installedCursor, pluginRoot, paths.stateRoot, options);
    mkdirSync(dirname(paths.claudeWorkerConfig), { recursive: true });
    if (!jsonEquivalent(readJsonObject(paths.claudeWorkerConfig), configuredClaude)) {
      writeFileSync(paths.claudeWorkerConfig, `${JSON.stringify(configuredClaude, null, 2)}\n`, "utf8");
    }
  }
  return onboardingStatus({ ...options, configPath, stateRoot: paths.stateRoot });
}
