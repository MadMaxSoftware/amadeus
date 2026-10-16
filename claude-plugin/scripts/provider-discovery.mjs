/**
 * Consent-based, computer-only provider discovery.
 * Scans only loopback / explicit owner-supplied loopback endpoints.
 * Never scans LAN addresses. Detection alone grants no routing authority.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DISCOVERY_SCHEMA = 1;
export const DISCOVERY_DISCLOSURE_VERSION = 3;
export const DISCOVERY_SCOPES = Object.freeze(["local-providers", "development-tools", "hardware"]);
export const DISCOVERY_DISCLOSURE = "Optional discovery reads selected CPU/GPU/memory/OS fields, relevant development and automation software registrations and known or explicitly selected local locations, and model names advertised by local loopback services. Results remain local and can be viewed or deleted. No personal-document crawling, LAN scanning, serial numbers or discovered-application execution. Consent alone does not start collection; request a scan separately. Revocation stops further collection. Narrow known dependency checks and cached subscription model availability are ordinary operation and do not need this opt-in.";

export const LOOPBACK_HOSTS = Object.freeze(new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]));

/** Well-known local OpenAI-compatible / inference ports (loopback only). */
export const KNOWN_LOCAL_PROVIDERS = Object.freeze([
  { id: "ollama", kind: "ollama", defaultPort: 11434, path: "/api/tags", openaiPath: "/v1/models" },
  { id: "lmstudio", kind: "lmstudio", defaultPort: 1234, path: "/v1/models", openaiPath: "/v1/models" },
  { id: "llamacpp", kind: "llamacpp", defaultPort: 8080, path: "/v1/models", openaiPath: "/v1/models" },
  { id: "vllm", kind: "vllm", defaultPort: 8000, path: "/v1/models", openaiPath: "/v1/models" },
  { id: "localai", kind: "localai", defaultPort: 8080, path: "/v1/models", openaiPath: "/v1/models" },
  { id: "openai-compatible-loopback", kind: "openai-compatible", defaultPort: 11434, path: "/v1/models", openaiPath: "/v1/models" },
]);

export function defaultDiscoveryPaths(stateRoot) {
  const root = join(resolve(stateRoot), "providers");
  return {
    root,
    consentPath: join(root, "discovery-consent.json"),
    lastScanPath: join(root, "last-discovery.json"),
  };
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function defaultDiscoveryConsent() {
  return {
    schemaVersion: DISCOVERY_SCHEMA,
    discovery: false,
    grantedAt: null,
    declinedAt: null,
    allowLan: false,
    note: "Explicit consent required before local provider discovery. LAN scanning is never enabled.",
  };
}

export function grantDiscoveryConsent(consentPath, now = new Date(), scopes = DISCOVERY_SCOPES) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => !DISCOVERY_SCOPES.includes(scope))) {
    throw new Error("Unsupported discovery scope; a new disclosure and explicit consent are required.");
  }
  const consent = {
    schemaVersion: DISCOVERY_SCHEMA,
    disclosureVersion: DISCOVERY_DISCLOSURE_VERSION,
    scopes: [...new Set(scopes)],
    discovery: true,
    grantedAt: now.toISOString(),
    declinedAt: null,
    allowLan: false,
    note: DISCOVERY_DISCLOSURE,
  };
  saveJson(consentPath, consent);
  return consent;
}

export function declineDiscoveryConsent(consentPath, now = new Date()) {
  const consent = {
    schemaVersion: DISCOVERY_SCHEMA,
    discovery: false,
    grantedAt: null,
    declinedAt: now.toISOString(),
    allowLan: false,
    note: "Owner declined provider discovery.",
  };
  saveJson(consentPath, consent);
  return consent;
}

export function hasDiscoveryConsent(consent, scope = "local-providers") {
  return Boolean(consent && consent.schemaVersion === DISCOVERY_SCHEMA && consent.discovery === true && consent.allowLan === false
    && consent.disclosureVersion === DISCOVERY_DISCLOSURE_VERSION
    && DISCOVERY_SCOPES.includes(scope) && Array.isArray(consent.scopes)
    && consent.scopes.every(item => DISCOVERY_SCOPES.includes(item))
    && consent.scopes.includes(scope) && typeof consent.grantedAt === 'string'
    && Number.isFinite(Date.parse(consent.grantedAt)));
}

export function parseEndpoint(urlOrHostPort) {
  const raw = String(urlOrHostPort || "").trim();
  if (!raw) {
    const error = new Error("empty endpoint");
    error.code = "INVALID_ENDPOINT";
    throw error;
  }
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    const error = new Error(`invalid endpoint: ${raw}`);
    error.code = "INVALID_ENDPOINT";
    throw error;
  }
  const host = url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  return {
    href: url.href.replace(/\/$/, ""),
    protocol: url.protocol,
    host,
    port,
    pathname: url.pathname === "/" ? "" : url.pathname,
  };
}

export function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(h) || LOOPBACK_HOSTS.has(host) || h === "127.0.0.1";
}

export function assertLoopbackOnly(endpoint, { allowLan = false } = {}) {
  const parsed = typeof endpoint === "string" ? parseEndpoint(endpoint) : endpoint;
  if (allowLan === true) {
    const error = new Error("LAN scanning is forbidden by product policy; allowLan cannot be enabled.");
    error.code = "LAN_FORBIDDEN";
    throw error;
  }
  if (!isLoopbackHost(parsed.host)) {
    const error = new Error(`Refusing non-loopback endpoint host '${parsed.host}'. Discovery is computer-only.`);
    error.code = "NON_LOOPBACK";
    throw error;
  }
  // Reject private LAN literals even if somehow mislabeled.
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(parsed.host)) {
    const error = new Error(`Refusing LAN address '${parsed.host}'.`);
    error.code = "LAN_FORBIDDEN";
    throw error;
  }
  return parsed;
}

/**
 * Build the probe target list: known loopback defaults plus owner manual endpoints.
 * Manual endpoints must also be loopback.
 */
export function buildProbeTargets({ manualEndpoints = [], includeKnown = true } = {}) {
  const targets = [];
  if (includeKnown) {
    for (const provider of KNOWN_LOCAL_PROVIDERS) {
      if (provider.id === "openai-compatible-loopback") continue; // covered via manual / generic
      targets.push({
        providerId: provider.id,
        kind: provider.kind,
        url: `http://127.0.0.1:${provider.defaultPort}${provider.path}`,
        openaiUrl: `http://127.0.0.1:${provider.defaultPort}${provider.openaiPath}`,
        source: "known-loopback-default",
      });
    }
  }
  for (const manual of manualEndpoints) {
    const parsed = assertLoopbackOnly(manual);
    targets.push({
      providerId: `manual-${parsed.host}-${parsed.port}`,
      kind: "openai-compatible",
      url: `${parsed.href}${parsed.pathname && parsed.pathname !== "/" ? "" : "/v1/models"}`,
      openaiUrl: parsed.href.includes("/v1") ? parsed.href : `${parsed.href}/v1/models`,
      source: "manual",
      manual: true,
    });
  }
  // Deduplicate by URL
  const seen = new Set();
  return targets.filter((t) => {
    const key = t.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Probe a single target. `probe` injects transport: async ({url}) => ({ ok, status, body, latencyMs })
 * Never uploads hardware/model/prompt/source data.
 */
export async function probeTarget(target, probe, options = {}) {
  if (!hasDiscoveryConsent(options.consent)) {
    throw Object.assign(new Error("Provider discovery requires explicit owner consent."), { code: "DISCOVERY_CONSENT_REQUIRED" });
  }
  assertLoopbackOnly(target.url, { allowLan: false });
  const started = options.now?.() ?? Date.now();
  try {
    const response = await probe({ url: target.url, openaiUrl: target.openaiUrl, providerId: target.providerId });
    const latencyMs = (options.now?.() ?? Date.now()) - started;
    if (!response || response.ok !== true) {
      return {
        providerId: target.providerId,
        kind: target.kind,
        endpoint: target.url,
        available: false,
        reason: response?.reason || `probe failed status=${response?.status ?? "n/a"}`,
        latencyMs,
        models: [],
        routingAuthority: false,
        source: target.source,
      };
    }
    const models = normalizeModelList(response.body);
    return {
      providerId: target.providerId,
      kind: target.kind,
      endpoint: target.url,
      openaiEndpoint: target.openaiUrl,
      available: true,
      latencyMs,
      models,
      routingAuthority: false,
      source: target.source,
      note: "Detection alone grants no routing authority; separate per-provider approval and capability qualification are required.",
    };
  } catch (error) {
    return {
      providerId: target.providerId,
      kind: target.kind,
      endpoint: target.url,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      latencyMs: (options.now?.() ?? Date.now()) - started,
      models: [],
      routingAuthority: false,
      source: target.source,
    };
  }
}

export function normalizeModelList(body) {
  if (!body) return [];
  if (Array.isArray(body.models)) {
    return body.models.map((m) => ({
      id: String(m.name || m.id || m.model || "").trim(),
      name: String(m.name || m.id || "").trim() || null,
    })).filter((m) => m.id);
  }
  if (Array.isArray(body.data)) {
    return body.data.map((m) => ({
      id: String(m.id || m.name || "").trim(),
      name: String(m.id || m.name || "").trim() || null,
    })).filter((m) => m.id);
  }
  return [];
}

/**
 * Run consented discovery. Declined consent and no-LAN guarantees are enforced.
 */
export async function discoverProviders(input = {}) {
  const paths = input.paths ?? defaultDiscoveryPaths(input.stateRoot);
  const consent = input.consent ?? loadJson(paths.consentPath, defaultDiscoveryConsent());
  if (!hasDiscoveryConsent(consent)) {
    return {
      ok: false,
      status: "consent-required",
      discovered: [],
      reason: "Provider discovery requires explicit owner consent.",
      lanScan: false,
      routingAuthorityGranted: false,
    };
  }
  if (consent.allowLan === true) {
    return {
      ok: false,
      status: "lan-forbidden",
      discovered: [],
      reason: "LAN scanning is forbidden; consent.allowLan must remain false.",
      lanScan: false,
      routingAuthorityGranted: false,
    };
  }

  const targets = buildProbeTargets({
    manualEndpoints: input.manualEndpoints ?? [],
    includeKnown: input.includeKnown !== false,
  });

  // Hard guarantee: every target is loopback before probing.
  for (const target of targets) {
    assertLoopbackOnly(target.url);
  }

  const probe = input.probe;
  if (typeof probe !== "function") {
    return {
      ok: false,
      status: "unavailable",
      discovered: [],
      reason: "No probe transport configured.",
      lanScan: false,
      routingAuthorityGranted: false,
    };
  }

  const discovered = [];
  for (const target of targets) {
    const currentConsent = input.consent ?? loadJson(paths.consentPath, defaultDiscoveryConsent());
    if (!hasDiscoveryConsent(currentConsent)) return {
      ok: false, status: "consent-required", discovered: [],
      reason: "Discovery consent was revoked; collection stopped.",
      lanScan: false, routingAuthorityGranted: false,
    };
    discovered.push(await probeTarget(target, probe, { now: input.now, consent: currentConsent }));
  }

  if (!hasDiscoveryConsent(input.consent ?? loadJson(paths.consentPath, defaultDiscoveryConsent()))) return {
    ok: false, status: "consent-required", discovered: [],
    reason: "Discovery consent was revoked; no report saved.",
    lanScan: false, routingAuthorityGranted: false,
  };

  const available = discovered.filter((d) => d.available);
  const report = {
    ok: true,
    status: "scanned",
    schemaVersion: DISCOVERY_SCHEMA,
    scannedAt: (input.clock?.() ?? new Date()).toISOString(),
    lanScan: false,
    targetCount: targets.length,
    availableCount: available.length,
    discovered,
    routingAuthorityGranted: false,
    note: "Detection alone grants no routing authority. Approve each provider separately, then qualify capabilities.",
    subscriptionProviders: {
      codex: { role: "baseline-subscription-route", optionalDiscovery: true },
      cursor: { role: "optional-accelerator", optionalDiscovery: true },
    },
  };
  saveJson(paths.lastScanPath, report);
  return report;
}

/**
 * Rescan helper: same consent + loopback rules, optional manual endpoints only.
 */
export async function rescanProviders(input = {}) {
  return discoverProviders({ ...input, includeKnown: input.includeKnown !== false });
}

export function mergeManualEndpoint(existing = [], endpoint) {
  const parsed = assertLoopbackOnly(endpoint);
  const href = parsed.href;
  if (existing.some((e) => String(e) === href || String(e) === endpoint)) return [...existing];
  return [...existing, href];
}

export { loadJson as loadDiscoveryJson, saveJson as saveDiscoveryJson };
