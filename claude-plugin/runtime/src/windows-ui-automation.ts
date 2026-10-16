import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type WindowsUiCommand = `windows-ui-${"inspect" | "execute"}:${string}`;

type WindowsUiControl = {
  key: string;
  automationId?: string;
  name?: string;
  actions: Array<"invoke" | "setValue" | "select" | "toggle" | "expand" | "collapse">;
};

export type WindowsUiPlan = {
  schemaVersion: 1;
  application: {
    vendor?: string;
    processName: string;
    windowTitleContains: string;
  };
  timeoutMs: number;
  controls?: WindowsUiControl[];
  actions: Array<
    { type: "inspect" | "focus" }
    | { type: "invoke" | "select" | "toggle" | "expand" | "collapse"; control: string }
    | { type: "setValue"; control: string; value: string }
  >;
};

export type WindowsUiResult = {
  status: "passed" | "failed" | "unavailable";
  mode: "inspect" | "execute";
  summary: string;
  evidence: unknown[];
  timedOut: boolean;
};

const SAFE_PLAN_ROOT = ".amadeus/ui-plans/";
const PLAN_MAX_BYTES = 1024 * 1024;
const CONTROL_ACTIONS = new Set(["invoke", "setValue", "select", "toggle", "expand", "collapse"]);

function planPath(value: string): string | null {
  const normalized = value.trim().replace(/^['"`]|['"`]$/g, "").replaceAll("\\", "/");
  if (!normalized.startsWith(SAFE_PLAN_ROOT) || !normalized.endsWith(".json") || normalized.includes("//")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

/** Only an exact, explicit plan invocation is eligible for no-model desktop routing. */
export function parseWindowsUiObjective(objective: string): WindowsUiCommand | undefined {
  const match = objective.trim().match(/^(inspect|execute|run)\s+(?:the\s+)?(?:[A-Za-z0-9._-]+\s+)?windows\s+ui\s+plan\s+(.+?)[.!]?$/i)
    ?? objective.trim().match(/^(inspect|execute|run)\s+(?:the\s+)?zeiss\s+ui\s+plan\s+(.+?)[.!]?$/i);
  if (!match) return undefined;
  const path = planPath(match[2]);
  if (!path) return undefined;
  const mode = match[1].toLowerCase() === "execute" ? "execute" : "inspect";
  return `windows-ui-${mode}:${path}`;
}

export function parseWindowsUiCommand(command: string): { mode: "inspect" | "execute"; path: string } | null {
  const match = command.match(/^windows-ui-(inspect|execute):(.+)$/);
  if (!match) return null;
  const path = planPath(match[2]);
  return path ? { mode: match[1] as "inspect" | "execute", path } : null;
}

function exactPlanFile(workspace: string, relativePath: string): string {
  const root = resolve(workspace);
  const candidate = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Windows UI plan escapes the workspace");
  if (!existsSync(candidate)) throw new Error(`Windows UI plan not found: ${relativePath}`);
  return candidate;
}

export function validateWindowsUiPlan(value: unknown, mode: "inspect" | "execute"): WindowsUiPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows UI plan must be an object");
  const plan = value as Record<string, any>;
  if (plan.schemaVersion !== 1) throw new Error("Unsupported Windows UI plan schema");
  if (!plan.application || typeof plan.application !== "object") throw new Error("Windows UI plan requires an application binding");
  const processName = String(plan.application.processName ?? "").toLowerCase();
  if (!/^[A-Za-z0-9._-]{1,96}\.exe$/i.test(processName)) throw new Error("Windows UI process name must be an exact executable name");
  const title = String(plan.application.windowTitleContains ?? "").trim();
  if (title.length < 5 || title.length > 120) throw new Error("Windows UI window title match is missing or too broad");
  const vendor = typeof plan.application.vendor === "string" ? plan.application.vendor.trim() : "";
  if (vendor.length > 120) throw new Error("Windows UI application vendor is too long");
  if (!Number.isSafeInteger(plan.timeoutMs) || plan.timeoutMs < 1_000 || plan.timeoutMs > 30_000) throw new Error("Windows UI timeout must be between 1000 and 30000 ms");
  if (!Array.isArray(plan.actions) || plan.actions.length < 1 || plan.actions.length > 50) throw new Error("Windows UI plan requires 1-50 actions");
  const controls = new Map<string, WindowsUiControl>();
  for (const item of plan.controls ?? []) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(item.key)) {
      throw new Error("Windows UI control key is invalid");
    }
    if (controls.has(item.key)) throw new Error(`Duplicate Windows UI control key: ${item.key}`);
    const automationId = typeof item.automationId === "string" ? item.automationId.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!automationId && !name) throw new Error(`Windows UI control ${item.key} needs an automationId or name`);
    if ([automationId, name].some((part) => part.length > 160)) throw new Error(`Windows UI control ${item.key} identity is too long`);
    if (!Array.isArray(item.actions) || item.actions.length < 1 || item.actions.length > CONTROL_ACTIONS.size
      || new Set(item.actions).size !== item.actions.length
      || item.actions.some((action: unknown) => typeof action !== "string" || !CONTROL_ACTIONS.has(action))) {
      throw new Error(`Windows UI control ${item.key} has an unsupported action allowlist`);
    }
    controls.set(item.key, { key: item.key, ...(automationId ? { automationId } : {}), ...(name ? { name } : {}), actions: [...item.actions] });
  }
  for (const action of plan.actions) {
    if (!action || typeof action !== "object" || !["inspect", "focus", ...CONTROL_ACTIONS].includes(action.type)) throw new Error("Unsupported Windows UI action");
    if (action.type !== "inspect" && action.type !== "focus") {
      const control = controls.get(String(action.control ?? ""));
      if (!control || !control.actions.includes(action.type)) throw new Error("Windows UI action references a control that does not allow it");
    }
    if (action.type === "setValue" && (typeof action.value !== "string" || action.value.length > 16_384)) {
      throw new Error("Windows UI setValue requires text no longer than 16384 characters");
    }
  }
  return {
    schemaVersion: 1,
    application: { ...(vendor ? { vendor } : {}), processName: String(plan.application.processName), windowTitleContains: title },
    timeoutMs: plan.timeoutMs,
    ...(controls.size ? { controls: [...controls.values()] } : {}),
    actions: plan.actions.map((action: any) => action.type === "inspect" || action.type === "focus"
      ? { type: action.type as "inspect" | "focus" }
      : action.type === "setValue"
        ? { type: "setValue" as const, control: String(action.control), value: action.value }
        : { type: action.type as "invoke" | "select" | "toggle" | "expand" | "collapse", control: String(action.control) }),
  };
}

export function loadWindowsUiPlan(workspace: string, command: WindowsUiCommand): { mode: "inspect" | "execute"; planPath: string; plan: WindowsUiPlan } {
  const parsed = parseWindowsUiCommand(command);
  if (!parsed) throw new Error("Invalid Windows UI command");
  const absolute = exactPlanFile(workspace, parsed.path);
  const source = readFileSync(absolute);
  if (source.length > PLAN_MAX_BYTES) throw new Error("Windows UI plan exceeds 1 MiB");
  return { mode: parsed.mode, planPath: absolute, plan: validateWindowsUiPlan(JSON.parse(source.toString("utf8")), parsed.mode) };
}

export function runWindowsUiPlan(
  workspace: string,
  command: WindowsUiCommand,
  options: { platform?: NodeJS.Platform; scriptPath?: string; execute?: typeof execFileSync } = {},
): WindowsUiResult {
  const parsed = parseWindowsUiCommand(command);
  const mode = parsed?.mode ?? "inspect";
  let loaded: ReturnType<typeof loadWindowsUiPlan>;
  try { loaded = loadWindowsUiPlan(workspace, command); }
  catch (error) {
    return { status: "failed", mode, timedOut: false, evidence: [],
      summary: `The Windows UI plan was rejected before launch; no model was called: ${error instanceof Error ? error.message : String(error)}` };
  }
  const { planPath: absolute, plan } = loaded;
  if ((options.platform ?? process.platform) !== "win32") return {
    status: "unavailable", mode, timedOut: false, evidence: [], summary: "Windows UI Automation is unavailable on this operating system; no model was called.",
  };
  const script = options.scriptPath ?? join(import.meta.dirname, "windows-ui-automation.ps1");
  if (!existsSync(script)) return {
    status: "unavailable", mode, timedOut: false, evidence: [], summary: "The fixed Windows UI Automation helper is unavailable; no model was called.",
  };
  try {
    const output = (options.execute ?? execFileSync)("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", script,
      "-PlanPath", absolute, "-Mode", mode,
    ], { encoding: "utf8", windowsHide: true, timeout: plan.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    const rows = String(output).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return { status: "passed", mode, timedOut: false, evidence: rows,
      summary: `${mode === "inspect" ? "Inspected" : "Executed"} the Windows UI plan with ordinary software; no model was called.` };
  } catch (error) {
    const detail = error as Error & { code?: string; signal?: string };
    const timedOut = detail.code === "ETIMEDOUT" || detail.signal === "SIGTERM";
    return { status: "failed", mode, timedOut, evidence: [],
      summary: timedOut ? "The Windows UI plan reached its bounded timeout; no model was called."
        : `The Windows UI plan failed safely; no model was called: ${detail.message}` };
  }
}
