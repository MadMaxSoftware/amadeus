/**
 * Sandbox-safe Amadeus checks using vm SourceTextModule + readFileSync
 * (avoids Node realpath on C:\ which some app sandboxes deny).
 *
 * Invoke:
 *   node --experimental-vm-modules --input-type=module -e "import fs from 'node:fs'; await import('data:text/javascript,'+encodeURIComponent(fs.readFileSync('scripts/run-amadeus-vm-checks.mjs','utf8')))"
 * or via scripts/Invoke-AmadeusVmChecks.ps1
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const { SourceTextModule, SyntheticModule, createContext } = vm;
const root = process.env.AMADEUS_VM_ROOT || process.cwd();
const context = createContext({
  ...globalThis,
  process,
  console,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});
const cache = new Map();

async function load(file) {
  file = path.normalize(file);
  if (cache.has(file)) return cache.get(file);
  const code = fs.readFileSync(file, "utf8");
  const mod = new SourceTextModule(code, {
    identifier: file,
    context,
    initializeImportMeta(meta) {
      meta.url = `file:///${file.replace(/\\/g, "/")}`;
    },
  });
  cache.set(file, mod);
  await mod.link(async (specifier, referencingModule) => {
    if (specifier.startsWith("node:")) {
      const ns = await import(specifier);
      const syn = new SyntheticModule(
        Object.keys(ns),
        function () {
          for (const key of Object.keys(ns)) this.setExport(key, ns[key]);
        },
        { identifier: specifier, context },
      );
      await syn.link(() => {});
      await syn.evaluate();
      return syn;
    }
    let resolved = path.resolve(path.dirname(referencingModule.identifier), specifier);
    if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.mjs`)) resolved = `${resolved}.mjs`;
    return load(resolved);
  });
  await mod.evaluate();
  return mod;
}

const runtimeCandidates = [
  path.join(root, "plugins/amadeus/scripts/amadeus-runtime.mjs"),
  path.join(root, "plugin-source/amadeus/scripts/amadeus-runtime.mjs"),
];
const runtimePath = runtimeCandidates.find((candidate) => fs.existsSync(candidate));
if (!runtimePath) {
  throw new Error("Amadeus runtime module not found under plugins/amadeus or plugin-source/amadeus");
}
const rt = await load(runtimePath);
const {
  detectAccelerators,
  missingDependencyReport,
  AMADEUS_PRODUCT,
} = rt.namespace;

const temp = fs.mkdtempSync(path.join(process.env.TEMP || root, "amadeus-vm-"));
fs.mkdirSync(path.join(temp, "src"), { recursive: true });
fs.writeFileSync(path.join(temp, "src", "coordinator.ts"), "export {}\n");
fs.writeFileSync(path.join(temp, "src", "supervisor.ts"), "export {}\n");
fs.writeFileSync(path.join(temp, "operations-review.json"), "{}\n");
fs.writeFileSync(path.join(temp, "worker-config.json"), "{}\n");
const paths = {
  setupRoot: temp,
  stateRoot: path.join(temp, "state"),
  coordinatorRoot: temp,
  operations: path.join(temp, "operations-review.json"),
  workerConfig: path.join(temp, "worker-config.json"),
  cursorWorkerConfig: path.join(temp, "cursor-worker-config.json"),
  supervisor: path.join(temp, "src", "supervisor.ts"),
};
const deps = missingDependencyReport(paths);
const accel = detectAccelerators({
  which: () => null,
  cursorInstalled: false,
  catalogModels: [{ slug: "gpt-test", priority: 2 }],
  codexSignedIn: true,
});

const routing = fs.readFileSync(path.join(root, "src/work-routing.ts"), "utf8");
const fallbackOk = routing.includes("Cursor is unavailable; use the efficient listed Codex model")
  && /if \(profile\.taskClass === "routine-implementation" && input\.cursorInstalled\)/.test(routing);

const result = {
  ok: deps.ok === true
    && deps.cursorOptional === true
    && accel.cursor.optional === true
    && accel.cursor.available === false
    && accel.codex.available === true
    && accel.blocksStartupWhenCursorMissing === false
    && accel.blocksPreflightWhenCursorMissing === false
    && accel.blocksWorkWhenCursorMissing === false
    && fallbackOk
    && AMADEUS_PRODUCT.pluginName === "amadeus",
  product: AMADEUS_PRODUCT.displayName,
  deps,
  accel: {
    baseline: accel.baseline,
    cursorOptional: accel.cursor.optional,
    cursorAvailable: accel.cursor.available,
    codexAvailable: accel.codex.available,
    blocks: {
      startup: accel.blocksStartupWhenCursorMissing,
      preflight: accel.blocksPreflightWhenCursorMissing,
      work: accel.blocksWorkWhenCursorMissing,
    },
  },
  routingFallbackPresent: fallbackOk,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
