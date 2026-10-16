/**
 * Consent-based Amadeus update checking, staging, approval, and rollback.
 * Checks only MadMaxSoftware/amadeus. Never hot-replaces a running plugin;
 * activation leaves a pending-restart marker for the desktop host reload.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertPrivacyFlow } from "./privacy-guard.mjs";

export const UPDATE_REPO = Object.freeze({
  owner: "MadMaxSoftware",
  name: "amadeus",
  allowedRepos: Object.freeze(["MadMaxSoftware/amadeus"]),
});

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const MARKETPLACE_UPGRADE_COMMAND = "codex plugin marketplace upgrade amadeus";
export const CLAUDE_MARKETPLACE_UPGRADE_COMMAND = "claude plugin update amadeus@amadeus";

/** The upgrade command for the host this plugin copy was packaged for. */
export function marketplaceUpgradeCommandFor(pluginRoot) {
  return existsSync(join(pluginRoot, ".claude-plugin", "plugin.json"))
    ? CLAUDE_MARKETPLACE_UPGRADE_COMMAND : MARKETPLACE_UPGRADE_COMMAND;
}

const CONSENT_SCHEMA = 1;
const STATE_SCHEMA = 1;

export function parseSemver(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    const error = new Error("malformed version: empty");
    error.code = "MALFORMED_VERSION";
    throw error;
  }
  const cleaned = raw.trim().replace(/^v/i, "");
  // Strip build metadata (+...) and take core.pre-release for compare.
  const noBuild = cleaned.split("+")[0];
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(noBuild);
  if (!match) {
    const error = new Error(`malformed version: ${raw}`);
    error.code = "MALFORMED_VERSION";
    throw error;
  }
  return {
    raw: cleaned,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @returns {-1|0|1} */
export function compareSemver(left, right) {
  const a = typeof left === "string" ? parseSemver(left) : left;
  const b = typeof right === "string" ? parseSemver(right) : right;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const cmp = compareIdentifier(a.prerelease[i], b.prerelease[i]);
    if (cmp !== 0) return cmp < 0 ? -1 : 1;
  }
  return 0;
}

export function defaultUpdatePaths(stateRoot) {
  const root = join(resolve(stateRoot), "updates");
  return {
    root,
    consentPath: join(root, "consent.json"),
    statePath: join(root, "state.json"),
    stagedDir: join(root, "staged"),
    rollbackDir: join(root, "rollback"),
    pendingRestartPath: join(root, "pending-restart.json"),
  };
}

export function loadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function defaultConsent() {
  return {
    schemaVersion: CONSENT_SCHEMA,
    updateChecks: false,
    grantedAt: null,
    declinedAt: null,
    note: "Explicit owner consent required before any remote update check.",
  };
}

export function grantUpdateConsent(consentPath, now = new Date()) {
  const consent = {
    schemaVersion: CONSENT_SCHEMA,
    updateChecks: true,
    grantedAt: now.toISOString(),
    declinedAt: null,
    note: "Owner consented to check MadMaxSoftware/amadeus for updates.",
  };
  saveJson(consentPath, consent);
  return consent;
}

export function declineUpdateConsent(consentPath, now = new Date()) {
  const consent = {
    schemaVersion: CONSENT_SCHEMA,
    updateChecks: false,
    grantedAt: null,
    declinedAt: now.toISOString(),
    note: "Owner declined update checks; no remote release queries will run.",
  };
  saveJson(consentPath, consent);
  return consent;
}

export function hasUpdateConsent(consent) {
  return Boolean(consent && consent.updateChecks === true);
}

export function shouldCheckForUpdates({ lastCheckedAt, now = new Date(), intervalMs = UPDATE_CHECK_INTERVAL_MS, force = false }) {
  if (force) return true;
  if (!lastCheckedAt) return true;
  const last = Date.parse(String(lastCheckedAt));
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= intervalMs;
}

export function assertAllowedReleaseRepo(repoFullName) {
  const name = String(repoFullName || "").trim();
  if (!UPDATE_REPO.allowedRepos.includes(name)) {
    const error = new Error(`Update checks may only target ${UPDATE_REPO.allowedRepos.join(", ")}; got ${name || "(empty)"}`);
    error.code = "DISALLOWED_UPDATE_REPO";
    throw error;
  }
  return name;
}

/**
 * Normalize owner-visible release metadata from a GitHub-like release payload.
 * Does not download artifacts unless a separate stage step is invoked.
 */
export function normalizeReleaseMetadata(release, options = {}) {
  if (!release || typeof release !== "object") {
    const error = new Error("unavailable release metadata");
    error.code = "UNAVAILABLE_RELEASE";
    throw error;
  }
  const tag = String(release.tag_name ?? release.tagName ?? release.version ?? "").trim();
  if (!tag) {
    const error = new Error("malformed release: missing tag/version");
    error.code = "MALFORMED_RELEASE";
    throw error;
  }
  let version;
  try {
    version = parseSemver(tag);
  } catch (error) {
    error.code = error.code || "MALFORMED_RELEASE";
    throw error;
  }
  const repo = assertAllowedReleaseRepo(options.repoFullName ?? release.repository ?? `${UPDATE_REPO.owner}/${UPDATE_REPO.name}`);
  return {
    schemaVersion: 1,
    repo,
    tag: version.raw,
    version: version.raw,
    name: release.name ?? tag,
    body: typeof release.body === "string" ? release.body : "",
    publishedAt: release.published_at ?? release.publishedAt ?? null,
    htmlUrl: release.html_url ?? release.htmlUrl ?? `https://github.com/${repo}/releases/tag/${tag}`,
    tarballUrl: release.tarball_url ?? release.tarballUrl ?? null,
    zipballUrl: release.zipball_url ?? release.zipballUrl ?? null,
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
  };
}

export function classifyUpdate(currentVersion, remoteVersion) {
  let current;
  let remote;
  try {
    current = parseSemver(currentVersion);
  } catch {
    return { kind: "malformed", relation: "malformed-current", currentVersion, remoteVersion };
  }
  try {
    remote = parseSemver(remoteVersion);
  } catch {
    return { kind: "malformed", relation: "malformed-remote", currentVersion, remoteVersion };
  }
  const cmp = compareSemver(remote, current);
  if (cmp > 0) return { kind: "newer", relation: "remote-newer", currentVersion: current.raw, remoteVersion: remote.raw };
  if (cmp === 0) return { kind: "equal", relation: "same-version", currentVersion: current.raw, remoteVersion: remote.raw };
  return { kind: "older", relation: "remote-older", currentVersion: current.raw, remoteVersion: remote.raw };
}

/**
 * Perform a consent-gated update check. `fetchLatestRelease` must be injected
 * (tests supply fixtures; production may use GitHub API for MadMaxSoftware/amadeus only).
 */
export async function checkForUpdate(input = {}) {
  const now = input.now ?? new Date();
  const paths = input.paths ?? defaultUpdatePaths(input.stateRoot);
  const consent = input.consent ?? loadJson(paths.consentPath, defaultConsent());
  if (!hasUpdateConsent(consent)) {
    return {
      ok: false,
      status: "consent-required",
      checked: false,
      reason: "Update checks require explicit owner consent.",
      consent,
      marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    };
  }
  const state = input.state ?? loadJson(paths.statePath, { schemaVersion: STATE_SCHEMA, lastCheckedAt: null, lastResult: null });
  if (!shouldCheckForUpdates({ lastCheckedAt: state.lastCheckedAt, now, intervalMs: input.intervalMs, force: input.force })) {
    return {
      ok: true,
      status: "skipped-interval",
      checked: false,
      reason: "Last check was within the 24-hour window.",
      lastCheckedAt: state.lastCheckedAt,
      lastResult: state.lastResult ?? null,
      marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    };
  }

  const fetchLatestRelease = input.fetchLatestRelease;
  if (typeof fetchLatestRelease !== "function") {
    return {
      ok: false,
      status: "unavailable",
      checked: true,
      reason: "No release fetcher configured.",
      marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    };
  }

  let release;
  try {
    const privacyFlow = assertPrivacyFlow({
      flowId: "github-release-check",
      consent: hasUpdateConsent(consent),
      endpoint: "https://api.github.com/repos/MadMaxSoftware/amadeus/releases/latest",
      dataCategories: ["repository-identifier", "http-request-metadata"],
    });
    release = await fetchLatestRelease({
      owner: UPDATE_REPO.owner,
      name: UPDATE_REPO.name,
      repo: `${UPDATE_REPO.owner}/${UPDATE_REPO.name}`,
      privacyFlow,
    });
  } catch (error) {
    const result = {
      ok: false,
      status: "unavailable",
      checked: true,
      reason: error instanceof Error ? error.message : String(error),
      marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    };
    saveJson(paths.statePath, {
      schemaVersion: STATE_SCHEMA,
      lastCheckedAt: now.toISOString(),
      lastResult: result,
    });
    return result;
  }

  if (release == null) {
    const result = {
      ok: false,
      status: "unavailable",
      checked: true,
      reason: "Release endpoint returned no payload.",
      marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    };
    saveJson(paths.statePath, { schemaVersion: STATE_SCHEMA, lastCheckedAt: now.toISOString(), lastResult: result });
    return result;
  }

  let metadata;
  try {
    metadata = normalizeReleaseMetadata(release, { repoFullName: `${UPDATE_REPO.owner}/${UPDATE_REPO.name}` });
  } catch (error) {
    const result = {
      ok: false,
      status: error.code === "MALFORMED_RELEASE" || error.code === "MALFORMED_VERSION" ? "malformed" : "unavailable",
      checked: true,
      reason: error instanceof Error ? error.message : String(error),
      marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    };
    saveJson(paths.statePath, { schemaVersion: STATE_SCHEMA, lastCheckedAt: now.toISOString(), lastResult: result });
    return result;
  }

  const currentVersion = String(input.currentVersion || "0.0.0");
  const classification = classifyUpdate(currentVersion, metadata.version);
  const result = {
    ok: true,
    status: classification.kind,
    checked: true,
    currentVersion: classification.currentVersion ?? currentVersion,
    remoteVersion: classification.remoteVersion ?? metadata.version,
    relation: classification.relation,
    release: metadata,
    ownerVisible: {
      product: "Amadeus",
      repo: metadata.repo,
      version: metadata.version,
      name: metadata.name,
      publishedAt: metadata.publishedAt,
      notes: metadata.body,
      url: metadata.htmlUrl,
    },
    activationRequiresApproval: classification.kind === "newer",
    hotReplacement: false,
    marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
  };
  saveJson(paths.statePath, {
    schemaVersion: STATE_SCHEMA,
    lastCheckedAt: now.toISOString(),
    lastResult: {
      status: result.status,
      currentVersion: result.currentVersion,
      remoteVersion: result.remoteVersion,
      relation: result.relation,
      releaseTag: metadata.tag,
    },
  });
  return result;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFilesRecursive(root, base = root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    const relative = join(base === root ? entry : join(relativeTo(base, root), entry)).replaceAll("\\", "/");
    const st = statSync(absolute);
    if (st.isDirectory()) listFilesRecursive(absolute, base, out);
    else out.push({ path: relativeTo(base, absolute).replaceAll("\\", "/"), absolute, bytes: st.size });
  }
  return out;
}

function relativeTo(base, absolute) {
  const b = resolve(base);
  const a = resolve(absolute);
  if (a === b) return "";
  const prefix = b.endsWith("\\") || b.endsWith("/") ? b : `${b}\\`;
  if (a.startsWith(prefix) || a.startsWith(b + "/") || a.startsWith(b + "\\")) {
    return a.slice(b.length).replace(/^[\\/]/, "");
  }
  return a;
}

/**
 * Stage a release package locally after validation. Partial/invalid packages
 * are rejected and leave no pending activation.
 */
export function stageUpdate(input = {}) {
  const paths = input.paths ?? defaultUpdatePaths(input.stateRoot);
  const release = input.release;
  if (!release?.version) {
    return { ok: false, status: "malformed", reason: "Staged release metadata missing version." };
  }
  const files = Array.isArray(input.files) ? input.files : null;
  if (!files || files.length === 0) {
    return { ok: false, status: "partial", reason: "Staged package contains no files." };
  }
  const required = input.requiredPaths ?? ["plugins/amadeus/.codex-plugin/plugin.json"];
  const present = new Set(files.map((f) => String(f.path || f.relativePath || "").replaceAll("\\", "/")));
  const missingRequired = required.filter((p) => !present.has(p));
  if (missingRequired.length) {
    return {
      ok: false,
      status: "partial",
      reason: `Staged package missing required paths: ${missingRequired.join(", ")}`,
      missingRequired,
    };
  }
  if (input.validatePluginJson !== false) {
    const pluginFile = files.find((f) => String(f.path || "").replaceAll("\\", "/") === "plugins/amadeus/.codex-plugin/plugin.json");
    if (!pluginFile?.content && !pluginFile?.absolute) {
      return { ok: false, status: "partial", reason: "plugin.json content unavailable for validation." };
    }
    try {
      const text = pluginFile.content ?? readFileSync(pluginFile.absolute, "utf8");
      const json = JSON.parse(text);
      if (!json.version) return { ok: false, status: "malformed", reason: "plugin.json missing version." };
      const stagedVersion = parseSemver(String(json.version).split("+")[0]).raw;
      const releaseVersion = parseSemver(release.version).raw;
      if (compareSemver(stagedVersion, releaseVersion) !== 0
        && !String(json.version).startsWith(releaseVersion)) {
        // Allow plugin build metadata suffix (0.3.0+amadeus....) when core matches.
        const core = parseSemver(String(json.version)).raw;
        if (compareSemver(core, releaseVersion) !== 0) {
          return {
            ok: false,
            status: "malformed",
            reason: `Staged plugin version ${json.version} does not match release ${release.version}.`,
          };
        }
      }
    } catch (error) {
      return {
        ok: false,
        status: "malformed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  mkdirSync(paths.stagedDir, { recursive: true });
  for (const entry of readdirSync(paths.stagedDir)) {
    rmSync(join(paths.stagedDir, entry), { recursive: true, force: true });
  }
  const manifest = [];
  for (const file of files) {
    const rel = String(file.path || file.relativePath).replaceAll("\\", "/");
    const target = join(paths.stagedDir, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (file.content != null) writeFileSync(target, file.content);
    else if (file.absolute) copyFileSync(file.absolute, target);
    else return { ok: false, status: "partial", reason: `No content for staged file ${rel}` };
    manifest.push({ path: rel, sha256: hashFile(target), bytes: statSync(target).size });
  }
  const staged = {
    schemaVersion: 1,
    stagedAt: (input.now ?? new Date()).toISOString(),
    release,
    manifest,
    activationApproved: false,
    hotReplacement: false,
  };
  saveJson(join(paths.stagedDir, "stage-manifest.json"), staged);
  return { ok: true, status: "staged", staged, stagedDir: paths.stagedDir };
}

export function isActivationApproved(stageManifest) {
  return Boolean(stageManifest?.activationApproved === true);
}

/**
 * Explicit owner approval to activate a staged update. Does not hot-replace;
 * writes pending-restart guidance and preserves rollback snapshot of current files.
 */
export function approveActivation(input = {}) {
  const paths = input.paths ?? defaultUpdatePaths(input.stateRoot);
  const manifestPath = join(paths.stagedDir, "stage-manifest.json");
  const staged = input.staged ?? loadJson(manifestPath, null);
  if (!staged) {
    return { ok: false, status: "unavailable", reason: "No staged update to approve." };
  }
  if (input.approval !== true) {
    return {
      ok: false,
      status: "approval-required",
      reason: "Activation requires explicit approval=true from the owner.",
      staged,
    };
  }

  // Preserve current install snapshot for rollback when provided.
  if (Array.isArray(input.currentFiles) && input.currentFiles.length) {
    mkdirSync(paths.rollbackDir, { recursive: true });
    for (const entry of readdirSync(paths.rollbackDir)) {
      rmSync(join(paths.rollbackDir, entry), { recursive: true, force: true });
    }
    const rollbackManifest = [];
    for (const file of input.currentFiles) {
      const rel = String(file.path || file.relativePath).replaceAll("\\", "/");
      const target = join(paths.rollbackDir, ...rel.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      if (file.content != null) writeFileSync(target, file.content);
      else if (file.absolute) copyFileSync(file.absolute, target);
      rollbackManifest.push({ path: rel, sha256: existsSync(target) ? hashFile(target) : null });
    }
    saveJson(join(paths.rollbackDir, "rollback-manifest.json"), {
      schemaVersion: 1,
      preservedAt: (input.now ?? new Date()).toISOString(),
      fromVersion: input.currentVersion ?? null,
      toVersion: staged.release?.version ?? null,
      files: rollbackManifest,
    });
  }

  staged.activationApproved = true;
  staged.approvedAt = (input.now ?? new Date()).toISOString();
  saveJson(manifestPath, staged);

  const pending = {
    schemaVersion: 1,
    pendingRestart: true,
    hotReplacement: false,
    approvedAt: staged.approvedAt,
    version: staged.release?.version ?? null,
    marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    guidance: [
      "A staged Amadeus update is approved but not hot-replaced.",
      `Run: ${MARKETPLACE_UPGRADE_COMMAND}`,
      "Then restart Codex / ChatGPT desktop so it reloads the plugin cache.",
      "Confirm installed cache version against plugins/amadeus/.codex-plugin/plugin.json.",
    ],
  };
  saveJson(paths.pendingRestartPath, pending);
  return {
    ok: true,
    status: "pending-restart",
    staged,
    pendingRestart: pending,
    rollbackPreserved: existsSync(join(paths.rollbackDir, "rollback-manifest.json")),
  };
}

export function readPendingRestart(paths) {
  return loadJson(paths.pendingRestartPath, null);
}

export function clearPendingRestart(paths) {
  if (existsSync(paths.pendingRestartPath)) rmSync(paths.pendingRestartPath, { force: true });
}

/**
 * Restore preserved rollback snapshot into a target directory (or return file set).
 */
export function rollbackUpdate(input = {}) {
  const paths = input.paths ?? defaultUpdatePaths(input.stateRoot);
  const rollbackManifest = loadJson(join(paths.rollbackDir, "rollback-manifest.json"), null);
  if (!rollbackManifest) {
    return { ok: false, status: "unavailable", reason: "No rollback snapshot preserved." };
  }
  const restored = [];
  if (input.targetDir) {
    for (const file of rollbackManifest.files || []) {
      const source = join(paths.rollbackDir, ...String(file.path).split("/"));
      if (!existsSync(source)) continue;
      const target = join(input.targetDir, ...String(file.path).split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      restored.push(file.path);
    }
  }
  // Clear staged activation / pending restart after rollback decision.
  if (input.clearStaged !== false) {
    if (existsSync(paths.stagedDir)) rmSync(paths.stagedDir, { recursive: true, force: true });
    clearPendingRestart(paths);
  }
  return {
    ok: true,
    status: "rolled-back",
    fromVersion: rollbackManifest.toVersion ?? null,
    restoredVersion: rollbackManifest.fromVersion ?? null,
    restored,
    rollbackManifest,
  };
}

export function startupUpdateCheck(input = {}) {
  return checkForUpdate({ ...input, force: input.force ?? false });
}

export function invokeMarketplaceUpgradeGuidance() {
  return {
    command: MARKETPLACE_UPGRADE_COMMAND,
    hotReplacement: false,
    requiresDesktopRestart: true,
  };
}

// Keep renameSync import used for atomic consent swaps in future callers.
export function atomicWriteJson(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${absolute}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, body, "utf8");
    renameSync(temp, absolute);
  } catch {
    writeFileSync(absolute, body, "utf8");
  }
}

export { listFilesRecursive };
