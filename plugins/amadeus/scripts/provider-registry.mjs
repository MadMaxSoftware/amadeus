/**
 * Per-machine private provider registry.
 * Lives outside the public package. Detection does not enable routing;
 * each provider needs explicit owner approval plus capability qualification.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REGISTRY_SCHEMA = 1;

export function defaultRegistryPath(stateRoot) {
  return join(resolve(stateRoot), "providers", "registry.json");
}

export function emptyRegistry() {
  return {
    schemaVersion: REGISTRY_SCHEMA,
    updatedAt: null,
    providers: {},
    manualEndpoints: [],
    notes: "Private per-machine registry. Never ship inside the public package.",
  };
}

export function loadRegistry(path) {
  if (!existsSync(path)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyRegistry();
    return {
      ...emptyRegistry(),
      ...parsed,
      providers: typeof parsed.providers === "object" && parsed.providers && !Array.isArray(parsed.providers)
        ? parsed.providers
        : {},
      manualEndpoints: Array.isArray(parsed.manualEndpoints) ? parsed.manualEndpoints : [],
    };
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(path, registry) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const payload = {
    ...emptyRegistry(),
    ...registry,
    schemaVersion: REGISTRY_SCHEMA,
    updatedAt: new Date().toISOString(),
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const temp = `${absolute}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, body, "utf8");
    renameSync(temp, absolute);
  } catch {
    // Some sandboxes deny atomic rename; fall back to direct write.
    writeFileSync(absolute, body, "utf8");
    try { if (existsSync(temp)) writeFileSync(temp, ""); } catch { /* ignore */ }
  }
  return payload;
}

export function migrateRegistry(raw) {
  if (!raw || typeof raw !== "object") return emptyRegistry();
  if (raw.schemaVersion === REGISTRY_SCHEMA) {
    return {
      ...emptyRegistry(),
      ...raw,
      providers: raw.providers ?? {},
      manualEndpoints: Array.isArray(raw.manualEndpoints) ? raw.manualEndpoints : [],
    };
  }
  // Legacy v0 / unversioned: map array form if present.
  if (Array.isArray(raw.providers)) {
    const providers = {};
    for (const entry of raw.providers) {
      if (!entry?.id) continue;
      providers[entry.id] = normalizeProviderEntry(entry);
    }
    return {
      ...emptyRegistry(),
      schemaVersion: REGISTRY_SCHEMA,
      providers,
      manualEndpoints: Array.isArray(raw.manualEndpoints) ? raw.manualEndpoints : [],
      migratedFrom: raw.schemaVersion ?? 0,
    };
  }
  return {
    ...emptyRegistry(),
    providers: raw.providers && typeof raw.providers === "object" ? Object.fromEntries(
      Object.entries(raw.providers).map(([id, entry]) => [id, normalizeProviderEntry({ id, ...entry })]),
    ) : {},
    manualEndpoints: Array.isArray(raw.manualEndpoints) ? raw.manualEndpoints : [],
    migratedFrom: raw.schemaVersion ?? "unknown",
  };
}

export function normalizeProviderEntry(entry) {
  const id = String(entry.id || "").trim();
  return {
    id,
    kind: entry.kind || "openai-compatible",
    endpoint: entry.endpoint || entry.url || null,
    openaiEndpoint: entry.openaiEndpoint || null,
    detectedAt: entry.detectedAt || null,
    lastSeenAt: entry.lastSeenAt || null,
    available: Boolean(entry.available),
    approved: entry.approved === true,
    approvedAt: entry.approvedAt || null,
    enabled: entry.enabled === true,
    enabledAt: entry.enabledAt || null,
    models: Array.isArray(entry.models) ? entry.models : [],
    qualification: entry.qualification || null,
    routingAuthority: false, // never persisted as true from detection alone
    source: entry.source || "discovery",
  };
}

/**
 * Record discovery results without granting approval or routing authority.
 */
export function recordDiscovery(registry, discoveryReport, now = new Date()) {
  const next = migrateRegistry(registry);
  const stamp = now.toISOString();
  const discovered = Array.isArray(discoveryReport)
    ? discoveryReport
    : (discoveryReport?.discovered ?? []);
  for (const found of discovered) {
    const id = String(found.providerId || found.id || "").trim();
    if (!id) continue;
    const prior = next.providers[id] || {};
    next.providers[id] = normalizeProviderEntry({
      ...prior,
      id,
      kind: found.kind,
      endpoint: found.endpoint,
      openaiEndpoint: found.openaiEndpoint,
      detectedAt: prior.detectedAt || stamp,
      lastSeenAt: found.available ? stamp : prior.lastSeenAt || null,
      available: Boolean(found.available),
      models: found.models || [],
      // Preserve prior approval/enable; never auto-approve from detection.
      approved: prior.approved === true,
      approvedAt: prior.approvedAt || null,
      enabled: prior.enabled === true,
      enabledAt: prior.enabledAt || null,
      qualification: prior.qualification || null,
      source: found.source || prior.source || "discovery",
    });
  }
  next.updatedAt = stamp;
  return next;
}

export function approveProvider(registry, providerId, approval, now = new Date()) {
  const next = migrateRegistry(registry);
  const id = String(providerId || "").trim();
  const entry = next.providers[id];
  if (!entry) {
    const error = new Error(`Unknown provider '${id}'. Discover it before approval.`);
    error.code = "UNKNOWN_PROVIDER";
    throw error;
  }
  if (approval !== true) {
    next.providers[id] = {
      ...entry,
      approved: false,
      approvedAt: null,
      enabled: false,
      enabledAt: null,
      routingAuthority: false,
    };
    next.updatedAt = now.toISOString();
    return next;
  }
  next.providers[id] = {
    ...entry,
    approved: true,
    approvedAt: now.toISOString(),
    routingAuthority: false,
  };
  next.updatedAt = now.toISOString();
  return next;
}

/**
 * Enabling requires prior approval. Still does not grant routing until qualified.
 */
export function enableProvider(registry, providerId, enabled = true, now = new Date()) {
  const next = migrateRegistry(registry);
  const id = String(providerId || "").trim();
  const entry = next.providers[id];
  if (!entry) {
    const error = new Error(`Unknown provider '${id}'.`);
    error.code = "UNKNOWN_PROVIDER";
    throw error;
  }
  if (enabled && entry.approved !== true) {
    const error = new Error(`Provider '${id}' is not approved; approval is required before enable.`);
    error.code = "APPROVAL_REQUIRED";
    throw error;
  }
  next.providers[id] = {
    ...entry,
    enabled: Boolean(enabled),
    enabledAt: enabled ? now.toISOString() : null,
    routingAuthority: false,
  };
  next.updatedAt = now.toISOString();
  return next;
}

export function setProviderQualification(registry, providerId, qualification, now = new Date()) {
  const next = migrateRegistry(registry);
  const id = String(providerId || "").trim();
  const entry = next.providers[id];
  if (!entry) {
    const error = new Error(`Unknown provider '${id}'.`);
    error.code = "UNKNOWN_PROVIDER";
    throw error;
  }
  next.providers[id] = {
    ...entry,
    qualification,
    lastQualifiedAt: now.toISOString(),
  };
  next.updatedAt = now.toISOString();
  return next;
}

export function listRoutableProviders(registry, options = {}) {
  const requirePilotGate = options.requirePilotGate !== false;
  const pilotGateOpen = options.pilotGateOpen === true || options.pilotGate === true;
  const reg = migrateRegistry(registry);
  const out = [];
  for (const entry of Object.values(reg.providers)) {
    if (entry.approved !== true || entry.enabled !== true) continue;
    if (!entry.qualification || entry.qualification.status !== "qualified") continue;
    if (requirePilotGate && !pilotGateOpen) continue;
    out.push({
      ...entry,
      routingAuthority: true,
    });
  }
  return out;
}

export function addManualEndpoint(registry, endpoint) {
  const next = migrateRegistry(registry);
  if (!next.manualEndpoints.includes(endpoint)) next.manualEndpoints.push(endpoint);
  return next;
}
