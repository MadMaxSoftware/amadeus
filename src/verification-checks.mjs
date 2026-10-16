/**
 * Pure verification-plan discovery (plain ESM for sandbox-friendly tests).
 * Kept separate from deterministic-verifier.ts so restricted Windows sandboxes
 * can load this module via data: URLs without TypeScript stripping.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, posix, resolve } from "node:path";

const EVIDENCE_PATCH_EXCLUDES = [
  ":(exclude,glob)**/evidence/patches/**/*.diff",
  ":(exclude,glob)**/evidence/patches/**/*.patch",
];

/**
 * Map `test/amadeus-updates-providers.test.mjs` →
 * `scripts/run-updates-providers-tests-sandbox.mjs` when present.
 */
export function resolveSandboxTestRunner(workspace, testPath) {
  const normalized = String(testPath || "").replaceAll("\\", "/");
  const base = posix.basename(normalized);
  const match = /^(?:amadeus-)?(.+)\.test\.mjs$/i.exec(base);
  if (!match) return null;
  const relative = `scripts/run-${match[1]}-tests-sandbox.mjs`;
  return existsSync(join(workspace, ...relative.split("/"))) ? relative : null;
}

/**
 * Build a PowerShell stdin-pipe check that never realpath()s the runner as an entry.
 * Clears host-injected NODE_OPTIONS (e.g. Cursor path-verifier --require under C:\)
 * so restricted Windows sandboxes that deny lstat('C:\\') can still start Node.
 */
export function buildSandboxPipeCheck(runnerRelativePath, nodeExecutable = process.execPath, workspace = null) {
  const runner = String(runnerRelativePath || "").replaceAll("\\", "/");
  const runnerPath = workspace ? join(workspace, ...runner.split("/")) : runner;
  const bootstrap = workspace ? `process.chdir(${JSON.stringify(resolve(workspace))});` : "";
  const powershellBootstrap = `'${bootstrap.replaceAll("'", "''")}'`;
  const command = workspace ? [
    "$env:NODE_OPTIONS=''",
    `$runnerSource=Get-Content -Raw -LiteralPath ${JSON.stringify(runnerPath)}`,
    "if ($runnerSource.StartsWith('#!')) { $newline=$runnerSource.IndexOf(\"`n\"); $runnerSource=if ($newline -ge 0) { $runnerSource.Substring($newline + 1) } else { '' } }",
    `@(${powershellBootstrap}; $runnerSource) | & ${JSON.stringify(nodeExecutable)} --input-type=module`,
  ].join("; ") : [
    "$env:NODE_OPTIONS=''",
    `Get-Content -Raw -LiteralPath ${JSON.stringify(runnerPath)} | & ${JSON.stringify(nodeExecutable)} --input-type=module`,
  ].join("; ");
  return {
    tool: "node",
    command: `powershell pipe ${runner}`,
    executable: "powershell",
    args: ["-NoProfile", "-Command", command],
  };
}

/**
 * Fixed read-only integrity checks over the disposable worker workspace.
 * These must not nest a Codex Windows sandbox when the parent worker already
 * holds a restricted token ("Restricted read-only access requires the elevated
 * Windows sandbox backend"). Prefer the stdin-piped workspace-diff-check runner
 * when present: native `git diff --check` fails closed on sandboxes that deny
 * Git getcwd or `.git` mutation, which would block the rest of verification.
 */
export function isDirectWorkspaceIntegrityCheck(check) {
  const command = String(check?.command || "");
  if (check?.tool === "git" && command === "git diff --check") return true;
  return /workspace-diff-check/.test(command);
}

function buildUniversalIntegrityCheck(workspace) {
  const runner = "scripts/workspace-diff-check.mjs";
  if (existsSync(join(workspace, ...runner.split("/")))) {
    return buildSandboxPipeCheck(runner, process.execPath, workspace);
  }
  return {
    tool: "git",
    command: "git diff --check",
    executable: "git",
    args: ["-c", `safe.directory=${workspace}`, "-c", "core.whitespace=cr-at-eol", "diff", "--check", "--", ".", ...EVIDENCE_PATCH_EXCLUDES],
  };
}

/**
 * Build a reusable, capability-based verification plan. Universal patch
 * integrity is always checked. Repository commands become hard gates only when
 * the project explicitly opts into them through package.json
 * `coordinator.verify`.
 */
export function discoverVerificationChecks(workspace, changedPaths = []) {
  const checks = [buildUniversalIntegrityCheck(workspace)];
  const seenPipeRunners = new Set(
    checks
      .map((check) => {
        const match = /powershell pipe\s+(.+)$/i.exec(String(check.command || ""));
        return match ? match[1].replaceAll("\\", "/") : null;
      })
      .filter(Boolean),
  );
  const safeChanged = [...new Set((changedPaths || []).map((path) => String(path).replaceAll("\\", "/")))]
    .filter((path) => path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path)
      && !path.split("/").some((part) => !part || part === "." || part === "..")
      && !/(^|\/)\.git(\/|$)/i.test(path));
  const testPattern = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/i;
  const runnableTests = new Set();
  for (const path of safeChanged) {
    if (testPattern.test(path) && existsSync(join(workspace, ...path.split("/")))) runnableTests.add(path);
    if (!/\.(?:[cm]?[jt]s)$/i.test(path) || testPattern.test(path)) continue;
    const extension = extname(path);
    const stem = path.slice(0, -extension.length);
    for (const candidate of [`${stem}.test${extension}`, `${stem}.spec${extension}`]) {
      if (existsSync(join(workspace, ...candidate.split("/")))) runnableTests.add(posix.normalize(candidate));
    }
  }
  const packagePath = join(workspace, "package.json");
  const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : {};
  const scripts = pkg?.scripts ?? {};
  const configured = pkg?.coordinator?.verify;
  const names = Array.isArray(configured) ? configured.map(String) : [];
  const unique = [...new Set(names)];
  if (runnableTests.size && !unique.length) {
    const tests = [...runnableTests].sort();
    const sandboxRunners = tests.map((path) => resolveSandboxTestRunner(workspace, path));
    if (sandboxRunners.length && sandboxRunners.every((runner) => typeof runner === "string")) {
      for (const runner of [...new Set(sandboxRunners)].sort()) {
        checks.push(buildSandboxPipeCheck(runner, process.execPath, workspace));
      }
    } else {
      const testSources = tests.map((path) => readFileSync(join(workspace, ...path.split("/")), "utf8")).join("\n");
      const packageTestScript = typeof scripts.test === "string" ? scripts.test : "";
      const packageManager = /vitest/i.test(packageTestScript) || /from\s+["']vitest["']|require\(["']vitest["']\)/.test(testSources)
        ? "vitest" : /jest/i.test(packageTestScript) || /from\s+["']@jest\/|from\s+["']jest["']/.test(testSources)
          ? "jest" : /mocha/i.test(packageTestScript) || /from\s+["']mocha["']/.test(testSources) ? "mocha" : null;
      if (packageManager && packageTestScript) {
        checks.push({
          tool: "npm",
          command: "npm test",
          executable: process.execPath,
          args: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "test", "--", ...tests],
        });
      } else if (!packageManager && tests.every((path) => {
        const source = readFileSync(join(workspace, ...path.split("/")), "utf8");
        return /from\s+["']node:test["']|require\(["']node:test["']\)/.test(source);
      })) {
        checks.push({
          tool: "node",
          command: `node --test --test-isolation=none ${tests.map((path) => JSON.stringify(path)).join(" ")}`,
          executable: process.execPath,
          args: ["--test", "--test-isolation=none", ...tests],
        });
      }
    }
  }
  for (const name of unique) {
    if (!/^[a-zA-Z0-9:_-]+$/.test(name) || typeof scripts[name] !== "string") {
      throw new Error(`Invalid coordinator verification script: ${name}`);
    }
    const scriptBody = scripts[name];
    const pipeMatch = /Get-Content\s+-Raw\s+(?:-LiteralPath\s+)?["']?([^\s"']+?\.mjs)["']?\s*\|\s*node\s+--input-type=module/i.exec(scriptBody)
      || /Get-Content\s+-Raw\s+(?:-LiteralPath\s+)?["']?([^\s"']+?\.mjs)["']?\s*\|\s*&?\s*node\s+--input-type=module/i.exec(scriptBody)
      || /\btype\s+([^\s|()]+\.mjs)\s*\|\s*node\s+--input-type=module/i.exec(scriptBody);
    if (pipeMatch && existsSync(join(workspace, ...pipeMatch[1].replaceAll("\\", "/").split("/")))) {
      const runner = pipeMatch[1].replaceAll("\\", "/");
      if (seenPipeRunners.has(runner)) continue;
      seenPipeRunners.add(runner);
      checks.push(buildSandboxPipeCheck(runner, process.execPath, workspace));
      continue;
    }
    checks.push({
      tool: "npm",
      command: `npm run ${name}`,
      executable: process.execPath,
      args: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "run", name],
    });
  }
  return checks;
}
