import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

function normalizedRoot(root) {
  return root ? resolve(root).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() : null;
}

function rootsOverlap(left, right) {
  const a = normalizedRoot(left); const b = normalizedRoot(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}

function projectKey(projectRoot) {
  return projectRoot
    ? createHash("sha256").update(normalizedRoot(projectRoot)).digest("hex").slice(0, 24)
    : "unscoped";
}

async function withRunAdmissionLock(database, action) {
  const claim = join(dirname(database), "active-goal-runs.claim");
  const deadline = Date.now() + 5_000;
  while (true) {
    try { mkdirSync(claim); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Timed out acquiring the project-run admission lock");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  try { return await action(); }
  finally { rmSync(claim, { recursive: true, force: true }); }
}

function readRunLock(lock) {
  try {
  if (!existsSync(lock)) return null;
  const requestPath = join(lock, "request.json");
  if (!existsSync(requestPath)) return { state: "starting", lock };
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const statePath = join(request.directory, "state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { state: "starting" };
  let alive = null;
  if (state.pid) {
    try { process.kill(state.pid, 0); alive = true; } catch (error) { alive = error.code !== "ESRCH"; }
  }
  return { ...state, runId: request.runId, goalId: request.args.goalId, projectRoot: request.args.projectRoot ?? null,
    directory: request.directory, lock, alive };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function activeRuns(database) {
  const runs = [];
  const legacy = readRunLock(join(dirname(database), "active-goal-run"));
  if (legacy) runs.push(legacy);
  const directory = join(dirname(database), "active-goal-runs");
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      const run = readRunLock(join(directory, name));
      if (run) runs.push(run);
    }
  }
  if (!existsSync(database)) return runs;
  // A background supervisor may briefly hold SQLite's write lock while the
  // host polls its run state. Wait for that bounded hand-off instead of
  // surfacing a transient SQLITE_BUSY as a failed run/self-test.
  const ledger = new DatabaseSync(database, { readOnly: true, timeout: 5_000 });
  try {
    return runs.map((run) => {
      if (run.projectRoot || !run.goalId) return run;
      const row = ledger.prepare("SELECT project_root FROM goals WHERE id=?").get(run.goalId);
      return row?.project_root ? { ...run, projectRoot: row.project_root } : run;
    });
  } finally { ledger.close(); }
}

export function activeRun(database, projectRoot = null) {
  const runs = activeRuns(database);
  return projectRoot ? runs.find((run) => rootsOverlap(projectRoot, run.projectRoot)) ?? null : runs[0] ?? null;
}

export function activeRunForGoal(database, goalId) {
  return activeRuns(database).find((run) => run.goalId === goalId) ?? null;
}

/** Stream supervisor logs to disk so long runs have neither a chat timeout nor an output-buffer ceiling. */
export async function executeSupervisor(executable, args, cwd, directory) {
  const stdoutPath = join(directory, "supervisor.stdout.json");
  const stderrPath = join(directory, "supervisor.stderr.log");
  const output = openSync(stdoutPath, "w");
  const errors = openSync(stderrPath, "w");
  try {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", output, errors] });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    const stderr = readFileSync(stderrPath, "utf8").slice(-8192);
    if (code !== 0) throw new Error(`Supervisor exited ${code}: ${stderr}`);
    return { stdout: readFileSync(stdoutPath, "utf8"), stderr };
  } finally { closeSync(output); closeSync(errors); }
}

export function lastRun(database, goalId) {
  const pointer = join(dirname(database), "goal-runs", `${goalId}.json`);
  if (!existsSync(pointer)) return null;
  const { directory } = JSON.parse(readFileSync(pointer, "utf8"));
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  const resultPath = join(directory, "result.json");
  return { ...state, directory, result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null };
}

export async function launchBackground(server, args, paths) {
  const roots = join(dirname(paths.database), "active-goal-runs");
  mkdirSync(roots, { recursive: true });
  let lock;
  const admission = await withRunAdmissionLock(paths.database, async () => {
    let active = activeRun(paths.database, args.projectRoot ?? null);
    // A terminal background run can leave its lock behind when the host exits
    // between writing the result and cleanup. Preserve the run directory, but
    // retire only that dead terminal lock so it cannot block a new goal.
    if (active?.alive === false && ["finished", "refused", "failed"].includes(String(active.state))) {
      const archivedLock = `${active.lock}.retired-${Date.now()}`;
      renameSync(active.lock, archivedLock);
      active = null;
    }
    if (active) {
      if (active.alive !== false && active.goalId && active.goalId !== args.goalId) {
        const pending = join(dirname(paths.database), "pending-goal-runs");
        mkdirSync(pending, { recursive: true });
        save(join(pending, `${args.goalId}.json`), { server, args, paths, queuedAt: new Date().toISOString() });
        return { result: { started: false, queued: true, background: { goalId: args.goalId, projectRoot: args.projectRoot ?? null, state: "queued" } } };
      }
      return { result: { ready: false, blockers: ["An existing background run for this project must finish or be reconciled before another can start."], background: active } };
    }
    lock = join(roots, projectKey(args.projectRoot));
    mkdirSync(lock);
    return { result: null };
  });
  if (admission.result) return admission.result;
  const runId = randomUUID();
  const directory = join(dirname(paths.database), "goal-runs", runId);
  const request = { runId, directory, lock, server, args, paths };
  let output;
  try {
    mkdirSync(directory, { recursive: true });
    save(join(directory, "request.json"), request);
    save(join(lock, "request.json"), request);
    save(join(directory, "state.json"), { state: "starting", at: new Date().toISOString() });
    save(join(dirname(paths.database), "goal-runs", `${args.goalId}.json`), { directory });
    output = openSync(join(directory, "host.log"), "a");
    const child = spawn(process.execPath, [server, "--background-request", join(directory, "request.json")], {
      cwd: dirname(server), detached: true, windowsHide: true, stdio: ["ignore", output, output],
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { started: true, background: { runId, pid: child.pid, directory }, persistentConfigurationChanged: false };
  } catch (error) {
    save(join(directory, "state.json"), { state: "failed", at: new Date().toISOString(), error: String(error) });
    rmSync(lock, { recursive: true });
    throw error;
  } finally { if (output !== undefined) closeSync(output); }
}

export function cancelPending(database, goalId) {
  rmSync(join(dirname(database), "pending-goal-runs", `${goalId}.json`), { force: true });
}

export function pendingRuns(database) {
  const directory = join(dirname(database), "pending-goal-runs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) =>
    ({ path: join(directory, name), ...JSON.parse(readFileSync(join(directory, name), "utf8")) }))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function drainPending(database, currentServer = null) {
  for (const next of pendingRuns(database)) {
    // Pending requests can outlive a cache-busted plugin installation. Rebase
    // them onto the server that owns the current background run rather than a
    // cached path saved by an older installation.
    const result = await launchBackground(currentServer ?? next.server, next.args, next.paths);
    if (result.started) cancelPending(database, next.args.goalId);
  }
}

export async function runBackground(requestPath, execute, afterCleanup = null) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const current = JSON.parse(readFileSync(join(request.lock, "request.json"), "utf8"));
  if (current.runId !== request.runId) throw new Error("Background run ownership changed");
  const statePath = join(request.directory, "state.json");
  save(statePath, { state: "running", pid: process.pid, at: new Date().toISOString() });
  try {
    const result = await execute(request);
    save(join(request.directory, "result.json"), result);
    save(statePath, { state: result.ready === false ? "refused" : "finished", pid: process.pid, at: new Date().toISOString() });
  } catch (error) {
    save(join(request.directory, "result.json"), { failed: true, error: error instanceof Error ? error.message : String(error) });
    save(statePath, { state: "failed", pid: process.pid, at: new Date().toISOString() });
  } finally {
    // A killed host never reaches here: its lock deliberately remains until process reconciliation.
    if (JSON.parse(readFileSync(join(request.lock, "request.json"), "utf8")).runId === request.runId) rmSync(request.lock, { recursive: true });
    await drainPending(request.paths.database, request.server);
    if (afterCleanup) await withRunAdmissionLock(request.paths.database, async () => afterCleanup(request));
  }
}
