import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

type Adapter = "codex" | "cursor" | "claude";

export function prepareWorkspaceIsolationAcceptance<T extends object>(input: {
  adapter: Adapter;
  config: T;
  workspace: string;
  artifactRoot: string;
  workspaceId: string;
}): T {
  const config = input.config as T & Record<string, unknown>;
  const harness = String(config.isolationAcceptanceHarness ?? "");
  if (!harness || !isAbsolute(harness) || !existsSync(harness)) {
    throw new Error(`${input.adapter} isolation acceptance harness is unavailable`);
  }
  mkdirSync(input.artifactRoot, { recursive: true });
  const prefix = resolve(input.artifactRoot, `${input.workspaceId}.${input.adapter}-isolation`);
  const receiptPath = `${prefix}.receipt.json`;
  const configPath = `${prefix}.config.json`;
  const evidencePath = `${prefix}.acceptance.jsonl`;
  const acceptanceConfig = input.adapter === "codex"
    ? { ...config, enabled: false, paidDispatchEnabled: false, automaticStartup: false,
      isolationVerified: false, isolationReceipt: receiptPath }
    : { ...config, enabled: false, dispatchAuthorized: false, implementationDispatchAuthorized: false,
      automaticStartup: false, writeIsolationVerified: false, writeIsolationReceipt: receiptPath };
  writeFileSync(configPath, `${JSON.stringify(acceptanceConfig, null, 2)}\n`, "utf8");
  try {
    const native = harness.endsWith('.mjs');
    const output = execFileSync(native ? process.execPath : "pwsh", [
      ...(native ? [harness] : ["-NoProfile", "-NonInteractive", "-File", harness]),
      "-Adapter", input.adapter,
      "-Workspace", input.workspace,
      "-ConfigPath", configPath,
      "-ReceiptPath", receiptPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(evidencePath, output, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = failed.stdout?.toString() ?? "";
    const stderr = failed.stderr?.toString() ?? "";
    writeFileSync(evidencePath, `${stdout}${stderr}${detail}\n`, "utf8");
    throw new Error(`${input.adapter} per-workspace isolation acceptance failed: ${detail}`);
  }
  if (!existsSync(receiptPath)) throw new Error(`${input.adapter} isolation acceptance did not issue a receipt`);
  JSON.parse(readFileSync(receiptPath, "utf8"));
  return (input.adapter === "codex"
    ? { ...config, isolationVerified: true, isolationReceipt: receiptPath }
    : { ...config, writeIsolationVerified: true, writeIsolationReceipt: receiptPath }) as T;
}
