/** Argument validation and small shared helpers for the MCP tools. */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Coordinator } from "./server-runtime.mjs";

export function object(value, label = "arguments") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function text(value, label, maximum = 20_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${label} is too long`);
  return result;
}

export function validateRoutePin(args) {
  const routeFieldsProvided = args.provider !== undefined || args.model !== undefined || args.reasoningEffort !== undefined;
  if (routeFieldsProvided && args.pinRoute !== true) {
    throw new Error("provider, model, and reasoningEffort require pinRoute=true; omit them for automatic coordinator routing");
  }
  return args.pinRoute === true;
}

export function cursorRoutePreflightProblem({ development, provider, cursorAcceleratorPresent, cursorWorker = {} }) {
  if (!development || provider !== "cursor-browser-login") return null;
  if (!cursorAcceleratorPresent) {
    return "Cursor was requested for this development goal but the optional Cursor accelerator is not installed; use ordinary software plus available Codex/GPT models, or install Cursor.";
  }
  if (cursorWorker.containmentWindowsSandbox !== "mxc" || cursorWorker.containmentProfile !== "cursor_contained"
    || cursorWorker.automaticStartup !== false || cursorWorker.authentication !== "browser-login"
    || cursorWorker.apiKeyAuthenticationAllowed !== false
    || !cursorWorker.isolationAcceptanceHarness || !existsSync(cursorWorker.isolationAcceptanceHarness)
    || !cursorWorker.isolationSecurityStateProbe || !existsSync(cursorWorker.isolationSecurityStateProbe)) {
    return "Cursor automatic route is missing its reviewed MXC containment or per-workspace acceptance preflight";
  }
  return null;
}

export function uuid(value, label = "goalId") {
  const result = text(value, label, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new Error(`${label} must be a UUID`);
  }
  return result;
}

export function writableWorkspacePaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("writableWorkspacePaths must be an array");
  const normalized = value.map((item) => {
    const path = text(item, "writableWorkspacePaths item", 500).replaceAll("\\", "/");
    if (path === "*") throw new Error("Unsafe writable workspace path: *");
    if (path === ".") return path;
    const parts = path.split("/");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.some((part) => !part || part === "." || part === "..")
      || parts[0].toLowerCase() === ".git" || path === ".worker-isolation.json") {
      throw new Error(`Unsafe writable workspace path: ${path}`);
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("Duplicate writable workspace path");
  return normalized;
}

export async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Optional accelerator configs (Cursor) must not crash startup/preflight when absent. */
export async function optionalJsonFile(path, fallback = {}) {
  if (!path || !existsSync(path)) return fallback;
  try {
    return await jsonFile(path);
  } catch {
    return fallback;
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

// `inherit` is a UI/configuration sentinel, never a provider model. Automatic
// routing must omit it so the supervisor selects a concrete route.
export function normalizeRouteModel(value, { pinned = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const model = String(value).trim();
  if (model.toLowerCase() === "inherit") {
    if (pinned) throw new Error("Invalid pinned model 'inherit'; specify a concrete model or leave routing automatic");
    return null;
  }
  return model;
}

export function contained(root, candidate, label) {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const relation = relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} is outside its fixed coordinator directory`);
  }
  return resolved;
}

export async function retrySqliteBusy(operation, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return operation(); }
    catch (error) {
      const busy = error?.code === "SQLITE_BUSY" || /database is locked/i.test(String(error?.message ?? error));
      if (!busy || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  throw new Error("SQLite retry loop ended unexpectedly");
}

export function withCoordinator(database, action) {
  const coordinator = new Coordinator(database);
  try { return action(coordinator); }
  finally { coordinator.close(); }
}
