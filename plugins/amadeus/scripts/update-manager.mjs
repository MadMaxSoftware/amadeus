/**
 * Consent-based Amadeus update checking. Checks only MadMaxSoftware/amadeus
 * and never downloads or installs anything: upgrades go through the host's
 * own plugin command, which the result names.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
