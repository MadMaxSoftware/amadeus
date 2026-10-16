import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrivateTermPatterns } from "./private-terms.mjs";

/** User-facing product identity. */
export const AMADEUS_PRODUCT = {
  pluginName: "amadeus",
  displayName: "Amadeus",
  descriptor: "Local AI Orchestrator",
  publisher: "Mad Max Systems",
  personalityAlias: "maestro",
  internalMcpServerId: "amadeus",
};

/** Repository / package identity used for developer-source fail-closed checks. */
export const AMADEUS_REPO_IDENTITY = {
  packageName: "amadeus-local-ai-orchestrator",
  pluginName: "amadeus",
  publicRemoteHints: Object.freeze([
    "madmaxsoftware/amadeus",
    "github.com/madmaxsoftware/amadeus",
  ]),
};

function localAppData(env = process.env) {
  return env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
}

export function defaultMachineConfigPath() {
  if (process.env.AMADEUS_CONFIG && process.env.AMADEUS_CONFIG.trim()) {
    return resolve(process.env.AMADEUS_CONFIG.trim());
  }
  return join(localAppData(), "Amadeus", "config.json");
}

export function defaultCanonicalStateRoot(env = process.env) {
  if (env.AMADEUS_HOME?.trim()) return resolve(env.AMADEUS_HOME.trim());
  return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Amadeus");
}

export function pluginRootFrom(metaUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

export function packagedRuntimeRoot(metaUrl = import.meta.url) {
  return join(pluginRootFrom(metaUrl), "runtime");
}

export function loadMachineConfig(configPath = defaultMachineConfigPath()) {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function nestedCoordinatorEntry(root) {
  return join(root, "coordinator", "src", "coordinator.ts");
}

function flatCoordinatorEntry(root) {
  return join(root, "src", "coordinator.ts");
}

function hasNestedCoordinator(root) {
  return Boolean(root) && existsSync(nestedCoordinatorEntry(root));
}

function hasFlatCoordinator(root) {
  return Boolean(root) && existsSync(flatCoordinatorEntry(root));
}

/**
 * Optional, owner-configured path markers that must never become executable
 * Amadeus authority. They live in the per-machine config (protectedPathMarkers),
 * never in the public package. Package identity checks remain the primary gate.
 */
export function foreignProjectPathMarkers(config = loadMachineConfig()) {
  const markers = Array.isArray(config?.protectedPathMarkers) ? config.protectedPathMarkers : [];
  return Object.freeze(markers.map(String).map((marker) => marker.trim()).filter(Boolean));
}

export function pathLooksLikeForeignProject(absolutePath, config = loadMachineConfig()) {
  if (!absolutePath) return false;
  const normalized = resolve(String(absolutePath)).toLowerCase().replaceAll("/", "\\");
  return foreignProjectPathMarkers(config).some((marker) => normalized.includes(marker.toLowerCase()));
}

export function isDeveloperModeEnabled(options = {}, config = null) {
  if (options.developerMode === true) return true;
  const env = options.env ?? process.env;
  if (String(env.AMADEUS_DEVELOPER_MODE ?? "").trim() === "1") return true;
  if (config?.developerMode === true) return true;
  return false;
}

export function readPackagedRuntimeIdentity(metaUrl = import.meta.url) {
  const root = packagedRuntimeRoot(metaUrl);
  const packagePath = join(root, "package.json");
  const pluginPaths = [".codex-plugin", ".claude-plugin"]
    .map(host => join(pluginRootFrom(metaUrl), host, "plugin.json")).filter(existsSync);
  if (pluginPaths.length > 1) throw new Error("Ambiguous packaged host identity");
  const pluginPath = pluginPaths[0];
  const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : null;
  const plugin = pluginPath ? JSON.parse(readFileSync(pluginPath, "utf8")) : null;
  return {
    root,
    packageName: pkg?.name ?? null,
    packageVersion: pkg?.version ?? null,
    pluginName: plugin?.name ?? null,
    pluginVersion: plugin?.version ?? null,
  };
}

function readSourceIdentity(candidateRoot) {
  const root = resolve(String(candidateRoot));
  const packagePaths = [
    join(root, "package.json"),
    join(root, "..", "package.json"),
    join(root, "..", "..", "package.json"),
  ];
  let pkg = null;
  let packagePath = null;
  for (const candidate of packagePaths) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (parsed?.name === AMADEUS_REPO_IDENTITY.packageName) {
        pkg = parsed;
        packagePath = candidate;
        break;
      }
    } catch {
      /* ignore malformed package.json */
    }
  }
  const pluginPath = existsSync(join(root, "plugins", "amadeus", ".codex-plugin", "plugin.json"))
    ? join(root, "plugins", "amadeus", ".codex-plugin", "plugin.json")
    : existsSync(join(dirname(packagePath ?? root), "plugins", "amadeus", ".codex-plugin", "plugin.json"))
      ? join(dirname(packagePath ?? root), "plugins", "amadeus", ".codex-plugin", "plugin.json")
      : null;
  let plugin = null;
  if (pluginPath && existsSync(pluginPath)) {
    try { plugin = JSON.parse(readFileSync(pluginPath, "utf8")); } catch { plugin = null; }
  }
  let remoteUrl = null;
  try {
    remoteUrl = execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    try {
      const repoRoot = packagePath ? dirname(packagePath) : root;
      remoteUrl = execFileSync("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }).trim();
    } catch {
      remoteUrl = null;
    }
  }
  return {
    root,
    packageName: pkg?.name ?? null,
    packageVersion: pkg?.version ?? null,
    pluginName: plugin?.name ?? null,
    pluginVersion: plugin?.version ?? null,
    remoteUrl,
    packagePath,
  };
}

/**
 * Fail-closed identity/version gate for developer source execution.
 * Public installs never call this for persisted setupRoot values.
 */
export function verifyDeveloperSourceIdentity(candidateRoot, options = {}) {
  const root = resolve(String(candidateRoot));
  if (pathLooksLikeForeignProject(root)) {
    return {
      ok: false,
      code: "FOREIGN_PROJECT_PATH",
      reason: "Refusing developer source execution for a foreign or legacy host project path.",
      root,
    };
  }
  if (!hasFlatCoordinator(root) && !hasNestedCoordinator(root)) {
    return {
      ok: false,
      code: "MISSING_COORDINATOR_ENTRY",
      reason: "Developer source root does not contain an Amadeus coordinator entry.",
      root,
    };
  }
  const source = readSourceIdentity(hasFlatCoordinator(root) ? root : join(root, "coordinator"));
  const packaged = options.packagedIdentity ?? readPackagedRuntimeIdentity(options.metaUrl ?? import.meta.url);
  if (source.packageName !== AMADEUS_REPO_IDENTITY.packageName) {
    return {
      ok: false,
      code: "PACKAGE_IDENTITY_MISMATCH",
      reason: "Developer source is not the authoritative Amadeus package identity.",
      root,
      sourcePackageName: source.packageName,
    };
  }
  if (packaged.packageVersion && source.packageVersion && source.packageVersion !== packaged.packageVersion) {
    return {
      ok: false,
      code: "VERSION_MISMATCH",
      reason: "Developer source version does not match the installed packaged runtime version.",
      root,
      sourceVersion: source.packageVersion,
      packagedVersion: packaged.packageVersion,
    };
  }
  if (source.pluginName && source.pluginName !== AMADEUS_REPO_IDENTITY.pluginName) {
    return {
      ok: false,
      code: "PLUGIN_IDENTITY_MISMATCH",
      reason: "Developer source plugin identity is not Amadeus.",
      root,
    };
  }
  if (source.remoteUrl) {
    const normalized = source.remoteUrl.toLowerCase().replaceAll("\\", "/");
    const remoteOk = AMADEUS_REPO_IDENTITY.publicRemoteHints.some((hint) => normalized.includes(hint));
    if (!remoteOk) {
      return {
        ok: false,
        code: "REMOTE_IDENTITY_MISMATCH",
        reason: "Developer source git remote is not the public Amadeus repository.",
        root,
      };
    }
  }
  return {
    ok: true,
    code: "OK",
    root,
    source,
    packaged,
  };
}

function layoutFromRoots(setupRoot, coordinatorRoot, extra = {}) {
  return {
    setupRoot: resolve(String(setupRoot)),
    coordinatorRoot: resolve(String(coordinatorRoot)),
    ...extra,
  };
}

function resolveExplicitSourceLayout(setupRoot, coordinatorRoot) {
  if (coordinatorRoot && existsSync(flatCoordinatorEntry(coordinatorRoot))) {
    const resolvedCoordinator = resolve(String(coordinatorRoot));
    const resolvedSetup = setupRoot
      ? resolve(String(setupRoot))
      : (hasNestedCoordinator(resolve(resolvedCoordinator, ".."))
        ? resolve(resolvedCoordinator, "..")
        : resolvedCoordinator);
    return layoutFromRoots(resolvedSetup, resolvedCoordinator);
  }
  if (setupRoot && hasNestedCoordinator(setupRoot)) {
    const resolved = resolve(String(setupRoot));
    return layoutFromRoots(resolved, join(resolved, "coordinator"));
  }
  if (setupRoot && hasFlatCoordinator(setupRoot)) {
    const resolved = resolve(String(setupRoot));
    return layoutFromRoots(resolved, resolved);
  }
  return null;
}

/**
 * Executable Amadeus layout.
 *
 * Public/default: packaged plugin runtime only. Persisted setupRoot /
 * coordinatorRoot never select executable code.
 *
 * Developer source: requires explicit developer-mode opt-in plus
 * repository/runtime identity and version checks; fail closed on mismatch.
 *
 * In-process options.setupRoot / options.coordinatorRoot remain available for
 * focused tests and tooling when options.allowExplicitLayout === true, or when
 * developer mode verifies the candidate.
 */
export function resolveCoordinatorLayout(options = {}) {
  const metaUrl = options.metaUrl ?? import.meta.url;
  const config = options.config ?? loadMachineConfig(options.configPath);
  const developerMode = isDeveloperModeEnabled(options, config);
  const packaged = packagedRuntimeRoot(metaUrl);
  const packagedIdentity = readPackagedRuntimeIdentity(metaUrl);

  const explicit = resolveExplicitSourceLayout(options.setupRoot, options.coordinatorRoot);
  if (explicit) {
    if (options.allowExplicitLayout === true) {
      return { ...explicit, packaged: false, authority: "explicit-option" };
    }
    if (!developerMode) {
      // Ignore stale call-site leftovers that mirror persisted config unless tests opt in.
      // Fall through to packaged authority.
    } else {
      const gate = verifyDeveloperSourceIdentity(explicit.coordinatorRoot, { metaUrl, packagedIdentity });
      if (!gate.ok) {
        const error = new Error(`Amadeus developer source refused: ${gate.code}: ${gate.reason}`);
        error.code = gate.code;
        error.details = gate;
        throw error;
      }
      return { ...explicit, packaged: false, authority: "developer-source", identity: gate };
    }
  }

  if (developerMode) {
    const envRoot = (options.env ?? process.env).AMADEUS_SETUP_ROOT;
    const persisted = resolveExplicitSourceLayout(
      envRoot || config?.setupRoot,
      config?.coordinatorRoot,
    );
    if (persisted) {
      const gate = verifyDeveloperSourceIdentity(persisted.coordinatorRoot, { metaUrl, packagedIdentity });
      if (!gate.ok) {
        const error = new Error(`Amadeus developer source refused: ${gate.code}: ${gate.reason}`);
        error.code = gate.code;
        error.details = gate;
        throw error;
      }
      return { ...persisted, packaged: false, authority: "developer-source", identity: gate };
    }
    const error = new Error(
      "Amadeus developer mode is enabled but no verified source root was provided. "
        + "Set AMADEUS_SETUP_ROOT to the authoritative Amadeus repository checkout.",
    );
    error.code = "DEVELOPER_SOURCE_REQUIRED";
    throw error;
  }

  if (hasFlatCoordinator(packaged)) {
    return layoutFromRoots(packaged, packaged, {
      packaged: true,
      authority: "packaged-runtime",
      identity: packagedIdentity,
    });
  }

  throw new Error(
    "Amadeus packaged runtime is missing or damaged. Reinstall the Amadeus plugin, "
      + "or enable AMADEUS_DEVELOPER_MODE=1 with a verified Amadeus source checkout.",
  );
}

/**
 * Resolve the executable setup root. Public installs always return the
 * packaged runtime; persisted setupRoot is not authoritative.
 */
export function resolveSetupRoot(options = {}) {
  return resolveCoordinatorLayout(options).setupRoot;
}

/**
 * Durable goal/history state root. Executable layout is independent.
 * Prefer Amadeus home, then legacy env, then machine config stateRoot, then a
 * non-authoritative legacy setup sibling when present for compatibility.
 */
export function resolveStateRoot(options = {}) {
  if (options.stateRoot) return resolve(String(options.stateRoot));
  const env = options.env ?? process.env;
  if (env.AMADEUS_HOME?.trim()) return resolve(env.AMADEUS_HOME.trim());
  const config = options.config ?? loadMachineConfig(options.configPath);
  if (config?.stateRoot) return resolve(String(config.stateRoot));

  // Compatibility reader only: never selects executable Amadeus code.
  const legacySetupHint = options.setupRoot
    ?? config?.legacySetupRootHint
    ?? config?.setupRoot
    ?? null;
  if (legacySetupHint) {
    const sibling = join(resolve(String(legacySetupHint)), "coordinator-state");
    if (existsSync(sibling) || existsSync(join(sibling, "coordinator.sqlite"))) return sibling;
  }

  return defaultCanonicalStateRoot(env);
}

export function buildProductionPaths(options = {}) {
  const layout = resolveCoordinatorLayout(options);
  const setupRoot = layout.setupRoot;
  const coordinatorRoot = layout.coordinatorRoot;
  const stateRoot = resolveStateRoot({ ...options, setupRoot: undefined });
  const configRoot = layout.packaged ? join(stateRoot, "runtime-config") : coordinatorRoot;
  return {
    setupRoot,
    stateRoot,
    coordinatorRoot,
    runtimePackaged: layout.packaged === true,
    runtimeAuthority: layout.authority ?? (layout.packaged ? "packaged-runtime" : "developer-source"),
    database: join(stateRoot, "coordinator.sqlite"),
    operations: join(configRoot, "operations-review.json"),
    workerConfig: join(configRoot, "worker-config.json"),
    cursorWorkerConfig: join(configRoot, "cursor-worker-config.json"),
    claudeWorkerConfig: join(configRoot, "claude-worker-config.json"),
    workerManifest: join(stateRoot, "worker-source-manifest.json"),
    approvedManifest: join(stateRoot, "backup", "remote-backup-scope.json"),
    // Legacy PowerShell helpers are not part of the public packaged runtime.
    // Callers must not treat these paths as required executable authority.
    manifestScript: null,
    packagesRoot: join(stateRoot, "goal-packages"),
    artifactRoot: join(stateRoot, "patches"),
    workspaceRoot: join(stateRoot, "worker-workspaces"),
    goalPackageScript: null,
    supervisor: join(coordinatorRoot, "src", "supervisor.ts"),
  };
}

export function missingDependencyReport(paths) {
  // Baseline runtime: ordinary software + coordinator + Codex worker config.
  // Cursor config is an optional accelerator and must not block startup/preflight.
  const required = [
    ["coordinator entry", join(paths.coordinatorRoot, "src", "coordinator.ts")],
    ["operations policy", paths.operations],
    ["worker config", paths.workerConfig],
    ["supervisor", paths.supervisor],
  ];
  const optional = [
    ["cursor worker config", paths.cursorWorkerConfig],
    ["claude worker config", paths.claudeWorkerConfig],
  ];
  const missing = required.filter(([, path]) => !existsSync(path)).map(([label, path]) => ({ label, path }));
  const missingOptional = optional.filter(([, path]) => !existsSync(path)).map(([label, path]) => ({ label, path }));
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 24;
  return {
    ok: missing.length === 0 && nodeOk,
    nodeExecutable: process.execPath,
    nodeVersion: process.version,
    setupRoot: paths.setupRoot,
    stateRoot: paths.stateRoot,
    missing,
    missingOptional,
    cursorOptional: true,
    guidance: missing.length
      ? "Install or repair the missing coordinator files, then re-run onboarding (see docs/INSTALL.md or scripts/install-dependencies.mjs)."
      : (missingOptional.length
        ? "Amadeus baseline dependencies look present. Optional Cursor accelerator config is absent; ordinary software plus available Codex/GPT models remain the fallback."
        : "Amadeus dependencies look present."),
  };
}

/**
 * Detect optional external development accelerators at runtime.
 * Missing Cursor never fails the baseline; Codex/GPT signed-in models plus
 * ordinary software remain the supported fallback.
 */
export function detectAccelerators(options = {}) {
  const which = typeof options.which === "function"
    ? options.which
    : (command) => {
      try {
        const output = execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
      } catch {
        return null;
      }
    };
  const cursorPath = options.cursorPath ?? which("cursor-agent") ?? which("cursor");
  const codexPath = options.codexPath ?? which("codex");
  const cursorConfigured = Boolean(options.cursorWorkerConfigPath && existsSync(options.cursorWorkerConfigPath));
  const cursorAvailable = Boolean(options.cursorInstalled ?? cursorPath);
  const catalogModels = Array.isArray(options.catalogModels) ? options.catalogModels : [];
  const nodeOk = Boolean(process.execPath);
  return {
    schemaVersion: 1,
    baseline: "ordinary-software+available-codex-gpt-models",
    node: { available: nodeOk, executable: process.execPath ?? null, version: process.version },
    git: { available: Boolean(options.gitPath ?? which("git")) },
    cursor: {
      available: cursorAvailable,
      optional: true,
      path: cursorPath,
      configured: cursorConfigured,
      role: "optional-capability-accelerator",
    },
    codex: {
      available: Boolean(codexPath) || catalogModels.length > 0 || options.codexSignedIn === true,
      path: codexPath,
      signedInModels: catalogModels,
      role: "baseline-subscription-route",
    },
    blocksStartupWhenCursorMissing: false,
    blocksPreflightWhenCursorMissing: false,
    blocksWorkWhenCursorMissing: false,
  };
}

/**
 * Per-machine lifecycle paths (updates + providers) live under stateRoot,
 * never inside the public package.
 */
export function lifecycleStatePaths(stateRoot) {
  const root = resolve(String(stateRoot));
  return {
    stateRoot: root,
    updatesRoot: join(root, "updates"),
    providersRoot: join(root, "providers"),
    updateConsent: join(root, "updates", "consent.json"),
    discoveryConsent: join(root, "providers", "discovery-consent.json"),
    providerRegistry: join(root, "providers", "registry.json"),
  };
}

export function writeMachineConfig(config, configPath = defaultMachineConfigPath()) {
  const absolute = resolve(configPath);
  mkdirSync(dirname(absolute), { recursive: true });
  const developerMode = config.developerMode === true;
  const stateRoot = resolve(String(
    config.stateRoot
    ?? (developerMode && config.setupRoot
      ? join(resolve(String(config.setupRoot)), "coordinator-state")
      : defaultCanonicalStateRoot()),
  ));
  // setupRoot / coordinatorRoot are retained only as non-authoritative migration
  // hints unless developerMode is explicitly enabled for source execution.
  const setupHint = config.setupRoot ? resolve(String(config.setupRoot)) : null;
  const payload = {
    schemaVersion: 3,
    product: AMADEUS_PRODUCT.displayName,
    descriptor: AMADEUS_PRODUCT.descriptor,
    publisher: AMADEUS_PRODUCT.publisher,
    runtimeAuthority: developerMode ? "developer-source" : "packaged",
    developerMode,
    setupRoot: setupHint,
    legacySetupRootHint: config.legacySetupRootHint
      ? resolve(String(config.legacySetupRootHint))
      : setupHint,
    stateRoot,
    // Legacy hints only, never authorization. Lifecycle consent files are authoritative.
    consentAuthority: "lifecycle-files",
    consents: {
      updateChecks: false,
      providerDiscovery: false,
    },
    localModelRouting: {
      releaseChannel: "stable",
      experimentalPilotGate: false,
      note: "0.4 local-model routing remains disabled on the stable channel until the friend-machine pilot passes.",
    },
    lifecycle: lifecycleStatePaths(stateRoot),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/** Migrate schemaVersion 1/2 machine configs without enabling consents or source authority. */
export function migrateMachineConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.schemaVersion >= 3 && raw.lifecycle && raw.consents && raw.runtimeAuthority) return raw;
  const stateRoot = raw.stateRoot ? resolve(String(raw.stateRoot)) : null;
  return {
    ...raw,
    schemaVersion: 3,
    runtimeAuthority: raw.developerMode === true ? "developer-source" : "packaged",
    developerMode: raw.developerMode === true,
    legacySetupRootHint: raw.legacySetupRootHint ?? raw.setupRoot ?? null,
    consents: {
      updateChecks: raw.consents?.updateChecks === true,
      providerDiscovery: raw.consents?.providerDiscovery === true,
    },
    localModelRouting: raw.localModelRouting ?? {
      releaseChannel: "stable",
      experimentalPilotGate: false,
      note: "0.4 local-model routing remains disabled on the stable channel until the friend-machine pilot passes.",
    },
    lifecycle: stateRoot ? lifecycleStatePaths(stateRoot) : raw.lifecycle ?? null,
  };
}

function privacyPatterns() {
  // Generic rules only. Owner-private names and paths come from a local,
  // git-ignored terms file (see private-terms.mjs), never from this source.
  return [
    { id: "fixed-nodejs-path", re: /C:\/Program Files\/nodejs\/node\.exe/i },
    // Sandbox runners load this module from a data: URL; search from the cwd then.
    ...loadPrivateTermPatterns({
      searchFrom: import.meta.url.startsWith("file:") ? dirname(fileURLToPath(import.meta.url)) : process.cwd(),
    }),
  ];
}

export const PRIVACY_BANNED_PATTERNS = privacyPatterns();

export function assertNoPersonalLeak(text, label = "artifact") {
  for (const { id, re } of privacyPatterns()) {
    if (re.test(text)) {
      throw new Error(`${label} contains disallowed personal or private project material: ${id}`);
    }
  }
}

export function resolveNodeCommand() {
  // Prefer PATH-resolved `node` in distributable MCP config; runtime can still
  // fall back to process.execPath for local scripts.
  return process.env.AMADEUS_NODE || "node";
}

export function isAbsoluteExisting(path) {
  return Boolean(path) && isAbsolute(path) && existsSync(path);
}
