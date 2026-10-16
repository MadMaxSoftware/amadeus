import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackOnly } from "./provider-discovery.mjs";

const moduleDir = import.meta.url.startsWith("file:")
  ? dirname(fileURLToPath(import.meta.url))
  : resolve(process.cwd(), "plugins", "amadeus", "scripts");
const pluginRoot = resolve(moduleDir, "..");
export const PRIVACY_FLOW_REGISTRY_PATH = resolve(pluginRoot, "privacy-flows.json");

export function loadPrivacyFlowRegistry(path = PRIVACY_FLOW_REGISTRY_PATH) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed?.schemaVersion !== 1 || parsed?.defaultDecision !== "deny" || !Array.isArray(parsed.flows)) {
    throw Object.assign(new Error("Invalid privacy-flow registry."), { code: "PRIVACY_REGISTRY_INVALID" });
  }
  const ids = parsed.flows.map((flow) => flow?.id);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
    throw Object.assign(new Error("Privacy-flow IDs must be unique nonempty strings."), { code: "PRIVACY_REGISTRY_INVALID" });
  }
  return parsed;
}

export function getPrivacyFlow(flowId, registry = loadPrivacyFlowRegistry()) {
  const flow = registry.flows.find((candidate) => candidate.id === flowId);
  if (!flow) throw Object.assign(new Error(`Undeclared privacy flow '${flowId}'.`), { code: "UNDECLARED_PRIVACY_FLOW" });
  return flow;
}

export function assertPrivacyFlow(input = {}, registry = loadPrivacyFlowRegistry()) {
  const flow = getPrivacyFlow(String(input.flowId || ""), registry);
  if (flow.explicitConsent && input.consent !== true) {
    throw Object.assign(new Error(`Privacy flow '${flow.id}' requires explicit consent.`), { code: "PRIVACY_CONSENT_REQUIRED" });
  }
  const categories = [...new Set((input.dataCategories || []).map(String))];
  const allowedCategories = new Set(flow.dataCategories || []);
  const disallowed = categories.filter((category) => !allowedCategories.has(category));
  if (disallowed.length) {
    throw Object.assign(new Error(`Privacy flow '${flow.id}' does not allow: ${disallowed.join(", ")}.`), { code: "PRIVACY_CATEGORY_DENIED" });
  }
  const endpoint = input.endpoint == null ? null : String(input.endpoint);
  if (flow.transport === "loopback-http") {
    assertLoopbackOnly(endpoint);
  } else if (flow.transport === "https") {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || !(flow.allowedOrigins || []).includes(parsed.origin)) {
      throw Object.assign(new Error(`Endpoint is not allowed for privacy flow '${flow.id}'.`), { code: "PRIVACY_ENDPOINT_DENIED" });
    }
  } else if (flow.transport === "approved-local-application") {
    if (!(flow.allowedOrigins || []).includes(String(input.provider || ""))) {
      throw Object.assign(new Error(`Provider is not allowed for privacy flow '${flow.id}'.`), { code: "PRIVACY_PROVIDER_DENIED" });
    }
  }
  return { ok: true, flowId: flow.id, recipient: flow.recipient, purpose: flow.purpose, dataCategories: categories };
}
