/**
 * Self-repair boundary for public Amadeus installs.
 *
 * Public installs never mutate arbitrary or stale source trees. Repairs may:
 *   1. target a verified authoritative Amadeus development repository under an
 *      explicit developer workflow, or
 *   2. produce a local reviewable repair artifact without modifying source.
 *
 * Historical / foreign project paths never receive source-mutation authority.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import {
  isDeveloperModeEnabled,
  loadMachineConfig,
  pathLooksLikeForeignProject,
  packagedRuntimeRoot,
  pluginRootFrom,
  readPackagedRuntimeIdentity,
  verifyDeveloperSourceIdentity,
} from "./amadeus-runtime.mjs";

export const SELF_REPAIR_MODES = Object.freeze({
  ARTIFACT_ONLY: "artifact-only",
  DEVELOPER_SOURCE: "developer-source",
  REFUSED: "refused",
});

/**
 * Decide whether a proposed repair target may be mutated.
 */
export function evaluateSelfRepairBoundary(options = {}) {
  const config = options.config ?? loadMachineConfig(options.configPath);
  const developerMode = isDeveloperModeEnabled(options, config);
  const requestedTarget = options.targetRoot
    ? resolve(String(options.targetRoot))
    : (options.setupRoot ? resolve(String(options.setupRoot)) : null);
  const packaged = packagedRuntimeRoot(options.metaUrl ?? import.meta.url);
  const packagedIdentity = readPackagedRuntimeIdentity(options.metaUrl ?? import.meta.url);

  if (!requestedTarget) {
    return {
      ok: true,
      mode: SELF_REPAIR_MODES.ARTIFACT_ONLY,
      mutateSource: false,
      reason: "No source target supplied; preserve a local reviewable repair artifact only.",
      packagedRuntime: packaged,
      packagedVersion: packagedIdentity.packageVersion,
    };
  }

  if (pathLooksLikeForeignProject(requestedTarget, config)) {
    return {
      ok: false,
      mode: SELF_REPAIR_MODES.REFUSED,
      mutateSource: false,
      code: "FOREIGN_OR_LEGACY_TARGET",
      reason: "Self-repair refuses to mutate a legacy host tree or unrelated project.",
      targetRoot: requestedTarget,
    };
  }

  if (!developerMode) {
    return {
      ok: true,
      mode: SELF_REPAIR_MODES.ARTIFACT_ONLY,
      mutateSource: false,
      code: "PUBLIC_ARTIFACT_ONLY",
      reason: "Public installs cannot edit source trees; emit a local reviewable repair artifact instead.",
      targetRoot: requestedTarget,
      packagedRuntime: packaged,
      packagedVersion: packagedIdentity.packageVersion,
    };
  }

  const gate = verifyDeveloperSourceIdentity(requestedTarget, {
    metaUrl: options.metaUrl ?? import.meta.url,
    packagedIdentity,
  });
  if (!gate.ok) {
    return {
      ok: false,
      mode: SELF_REPAIR_MODES.REFUSED,
      mutateSource: false,
      code: gate.code,
      reason: gate.reason,
      targetRoot: requestedTarget,
      details: gate,
    };
  }

  return {
    ok: true,
    mode: SELF_REPAIR_MODES.DEVELOPER_SOURCE,
    mutateSource: true,
    code: "DEVELOPER_SOURCE_ALLOWED",
    reason: "Verified authoritative Amadeus development repository under explicit developer mode.",
    targetRoot: requestedTarget,
    identity: gate,
  };
}

/**
 * Write a local reviewable repair artifact under the durable state root.
 * Never modifies source trees.
 */
function packagedVersion(metaUrl) {
  // Sandbox test runners load this module from a data: URL with no package beside it.
  if (!String(metaUrl).startsWith("file:")) return null;
  try { return readPackagedRuntimeIdentity(metaUrl).packageVersion ?? null; } catch { return null; }
}

export function writeLocalRepairArtifact(stateRoot, payload, options = {}) {
  const root = resolve(String(stateRoot));
  const dir = join(root, "repair-artifacts");
  mkdirSync(dir, { recursive: true });
  const id = options.id
    ?? `repair-${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}-${process.pid}`;
  if (!/^repair-[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error("Invalid repair artifact id");
  }
  const path = join(dir, `${id}.json`);
  // The fingerprint groups reports of the same failure class (code plus the
  // first line of the summary, with numbers and paths blurred) so a future
  // owner-approved report can be matched to an existing issue and a fix.
  const firstLine = String(payload?.summary ?? "").split(/\r?\n/)[0].toLowerCase()
    .replace(/[a-z]:[\\/]\S*/g, "<path>").replace(/\d+/g, "#").trim();
  const failureFingerprint = createHash("sha256").update(`${payload?.code ?? "unknown"}|${firstLine}`).digest("hex").slice(0, 16);
  const body = {
    schemaVersion: 2,
    kind: "amadeus-local-repair-artifact",
    mutateSource: false,
    createdAt: new Date().toISOString(),
    amadeusVersion: options.amadeusVersion ?? packagedVersion(options.metaUrl ?? import.meta.url),
    failureFingerprint,
    ...payload,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return { path, id, exists: existsSync(path), mutateSource: false };
}

/**
 * Convenience: evaluate boundary and, for public installs, write an artifact.
 */
export function planSelfRepair(options = {}) {
  const decision = evaluateSelfRepairBoundary(options);
  if (decision.mode === SELF_REPAIR_MODES.ARTIFACT_ONLY && options.stateRoot && options.artifactPayload) {
    const artifact = writeLocalRepairArtifact(options.stateRoot, {
      ...options.artifactPayload,
      boundary: {
        mode: decision.mode,
        reason: decision.reason,
        code: decision.code ?? null,
      },
    }, { id: options.artifactId });
    return { ...decision, artifact };
  }
  return decision;
}

function pathsOverlap(left, right) {
  const inside = (root, candidate) => {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const a = resolve(String(left)).toLowerCase();
  const b = resolve(String(right)).toLowerCase();
  return inside(a, b) || inside(b, a);
}

/**
 * Work may not target the installed plugin folder (the copy that updates
 * replace): a change there would be silent self-modification that is lost on
 * the next update. Only a verified Amadeus repository under explicit developer
 * mode may be changed; public installs get a local reviewable record instead.
 */
export function guardInstalledPluginTarget(projectRoot, options = {}) {
  const pluginRoot = resolve(options.pluginRoot ?? pluginRootFrom(options.metaUrl ?? import.meta.url));
  if (!projectRoot || !pathsOverlap(projectRoot, pluginRoot)) return { ok: true, overlapsInstalledPlugin: false };
  const decision = evaluateSelfRepairBoundary({ ...options, targetRoot: projectRoot });
  if (decision.mode === SELF_REPAIR_MODES.DEVELOPER_SOURCE) return { ok: true, overlapsInstalledPlugin: true, decision };
  return {
    ok: false,
    overlapsInstalledPlugin: true,
    code: "INSTALLED_PLUGIN_TARGET",
    reason: "This project folder contains the installed Amadeus plugin. Changes there would be overwritten by the next update, "
      + "so Amadeus records a local reviewable repair note instead of editing it. Work on a separate clone of the Amadeus repository.",
    decision,
  };
}
