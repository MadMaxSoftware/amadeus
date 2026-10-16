import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { loadManifest, validateManifestSources, type BackupManifest } from "./worker-isolation.ts";
import { writeDevelopmentManifest } from "./development-project.ts";

export type GoalStageRole = "development" | "participant" | "assessor";

export type GoalStage = {
  iteration: number;
  name: string;
  role: GoalStageRole;
  manifest: string;
  manifestSha256: string;
  objectiveMode: "coordinator" | "fixed";
  objectiveFile?: string;
  objectiveSha256?: string;
  allowedWritableWorkspacePaths: "caller-bounded" | string[];
  patchPolicy: "apply" | "capture-only";
  maximumChangedFiles: number | null;
  maximumChangedLines: number | null;
  handoff?: {
    fromIteration: number;
    requirePatch: boolean;
    resultDestination: string;
    patchDestination: string;
    generatedManifest: string;
  };
};

export type GoalExecutionPackage = {
  schemaVersion: 1;
  goalId: string;
  mode: "explicit" | "repeat";
  developmentMode?: boolean;
  routingMode?: "automatic" | "pinned";
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  selectedOpaqueCase?: string;
  allOpaqueCases?: string[];
  stages: GoalStage[];
};

export type PreparedGoalStage = {
  packagePath: string;
  stage: GoalStage;
  manifestPath: string;
  objectiveOverride: string | null;
  manifestValidation: ReturnType<typeof validateManifestSources>;
  selectedOpaqueCase: string | null;
  allOpaqueCases: string[];
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function safeRelative(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.trim().replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return normalized;
}

function inside(root: string, relativePath: string): string {
  const candidate = resolve(root, ...safeRelative(relativePath, "package path").split("/"));
  const relation = relative(root, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Package path escapes its root: ${relativePath}`);
  }
  return candidate;
}

function requireDigest(path: string, expected: string, label: string): void {
  if (!/^[0-9a-f]{64}$/i.test(expected) || sha256(path) !== expected.toUpperCase()) {
    throw new Error(`${label} digest mismatch`);
  }
}

function validateWritePaths(value: GoalStage["allowedWritableWorkspacePaths"]): void {
  if (value === "caller-bounded") return;
  if (!Array.isArray(value)) throw new Error("Stage writable paths are invalid");
  const normalized = value.map((item) => item === "." ? item : safeRelative(item, "stage writable path"));
  if (new Set(normalized).size !== normalized.length) throw new Error("Stage writable paths repeat");
}

function readPackage(packagePathInput: string, expectedGoalId: string): {
  packageRoot: string;
  packagePath: string;
  descriptor: GoalExecutionPackage;
} {
  const packagePath = realpathSync(packagePathInput);
  const packageRoot = dirname(packagePath);
  const descriptor = JSON.parse(readFileSync(packagePath, "utf8")) as GoalExecutionPackage;
  if (descriptor.schemaVersion !== 1 || descriptor.goalId !== expectedGoalId
    || !["explicit", "repeat"].includes(descriptor.mode) || !Array.isArray(descriptor.stages)
    || descriptor.stages.length === 0) {
    throw new Error("Unsupported, incomplete, or mismatched goal execution package");
  }
  const iterations = new Set<number>();
  for (const stage of descriptor.stages) {
    if (!Number.isSafeInteger(stage.iteration) || stage.iteration <= 0 || iterations.has(stage.iteration)) {
      throw new Error("Goal package stage iterations must be unique positive integers");
    }
    iterations.add(stage.iteration);
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(stage.name)
      || !["development", "participant", "assessor"].includes(stage.role)) {
      throw new Error("Goal package stage identity is invalid");
    }
    validateWritePaths(stage.allowedWritableWorkspacePaths);
    if (!["apply", "capture-only"].includes(stage.patchPolicy)
      || stage.maximumChangedFiles !== null && (!Number.isSafeInteger(stage.maximumChangedFiles) || stage.maximumChangedFiles < 0)
      || stage.maximumChangedLines !== null && (!Number.isSafeInteger(stage.maximumChangedLines) || stage.maximumChangedLines < 0)) {
      throw new Error(`${stage.name} patch policy or bounded change envelope is invalid`);
    }
    const manifestPath = inside(packageRoot, stage.manifest);
    requireDigest(manifestPath, stage.manifestSha256, `${stage.name} manifest`);
    loadManifest(manifestPath);
    if (stage.objectiveMode === "fixed") {
      if (!stage.objectiveFile || !stage.objectiveSha256) throw new Error(`${stage.name} fixed objective is incomplete`);
      const objectivePath = inside(packageRoot, stage.objectiveFile);
      requireDigest(objectivePath, stage.objectiveSha256, `${stage.name} objective`);
      if (!readFileSync(objectivePath, "utf8").trim()) throw new Error(`${stage.name} objective is empty`);
    } else if (stage.objectiveMode !== "coordinator" || stage.objectiveFile || stage.objectiveSha256) {
      throw new Error(`${stage.name} objective mode is invalid`);
    }
    if (stage.handoff) {
      if (!Number.isSafeInteger(stage.handoff.fromIteration)
        || stage.handoff.fromIteration <= 0 || stage.handoff.fromIteration >= stage.iteration) {
        throw new Error(`${stage.name} handoff source is invalid`);
      }
      for (const [label, value] of [
        ["result destination", stage.handoff.resultDestination],
        ["patch destination", stage.handoff.patchDestination],
        ["generated manifest", stage.handoff.generatedManifest],
      ] as const) safeRelative(value, `${stage.name} ${label}`);
    }
  }
  if (descriptor.selectedOpaqueCase !== undefined) {
    if (!Array.isArray(descriptor.allOpaqueCases) || !descriptor.allOpaqueCases.includes(descriptor.selectedOpaqueCase)) {
      throw new Error("Selected opaque case is not in the declared case set");
    }
    if (new Set(descriptor.allOpaqueCases).size !== descriptor.allOpaqueCases.length) {
      throw new Error("Opaque case set contains duplicates");
    }
  }
  return { packageRoot, packagePath, descriptor };
}

function stageFor(descriptor: GoalExecutionPackage, iteration: number): GoalStage {
  const exact = descriptor.stages.find((stage) => stage.iteration === iteration);
  if (exact) return exact;
  if (descriptor.mode === "repeat") return descriptor.stages.at(-1)!;
  throw new Error(`Goal execution package has no stage for iteration ${iteration}`);
}

function assertParticipantIsolation(
  descriptor: GoalExecutionPackage,
  stage: GoalStage,
  manifestPath: string,
): void {
  if (stage.role !== "participant") return;
  const manifest = loadManifest(manifestPath);
  const selected = descriptor.selectedOpaqueCase?.toLowerCase();
  const siblings = (descriptor.allOpaqueCases ?? []).filter((item) => item.toLowerCase() !== selected);
  for (const file of manifest.files) {
    const normalized = file.path.replaceAll("\\", "/").toLowerCase();
    if (/(^|\/)(assessor-only|criteria|private-analysis|evidence|runs)(\/|$)/.test(normalized)) {
      throw new Error(`Participant manifest exposes a protected path: ${file.path}`);
    }
    if (siblings.some((caseId) => normalized.split("/").includes(caseId.toLowerCase()))) {
      throw new Error(`Participant manifest exposes a sibling case: ${file.path}`);
    }
    const text = readFileSync(resolve(manifest.source.projectRoot, ...file.path.split("/")), "utf8");
    if (/assessor-only|expectedDirection|criticalFailures/i.test(text)) {
      throw new Error(`Participant source contains an assessor cue: ${file.path}`);
    }
  }
}

function addArtifact(
  manifest: BackupManifest,
  packageRoot: string,
  sourceRoot: string,
  sourcePath: string,
  destination: string,
): void {
  const target = inside(sourceRoot, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(realpathSync(sourcePath), target);
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Handoff artifact is not a regular file: ${destination}`);
  manifest.files.push({
    path: safeRelative(relative(sourceRoot, target).replaceAll("\\", "/"), "handoff path"),
    bytes: info.size,
    sha256: sha256(target),
    state: "immutable-previous-stage-handoff",
  });
  if (!relative(packageRoot, target)) throw new Error("Handoff target cannot be the package root");
}

export function inspectGoalExecutionPackage(
  packagePath: string,
  expectedGoalId: string,
  iteration: number,
  allowPendingHandoff = false,
  expectedOpaqueCase?: string | null,
): PreparedGoalStage {
  const loaded = readPackage(packagePath, expectedGoalId);
  if (expectedOpaqueCase && loaded.descriptor.selectedOpaqueCase?.toLowerCase() !== expectedOpaqueCase.toLowerCase()) {
    throw new Error(`Goal package case mismatch: expected ${expectedOpaqueCase}, found ${loaded.descriptor.selectedOpaqueCase ?? "none"}`);
  }
  const stage = stageFor(loaded.descriptor, iteration);
  if (stage.handoff && !allowPendingHandoff) throw new Error(`${stage.name} requires a prepared previous-stage handoff`);
  const manifestPath = inside(loaded.packageRoot, stage.manifest);
  const manifestValidation = validateManifestSources(manifestPath);
  assertParticipantIsolation(loaded.descriptor, stage, manifestPath);
  return {
    packagePath: loaded.packagePath,
    stage,
    manifestPath,
    objectiveOverride: stage.objectiveMode === "fixed"
      ? readFileSync(inside(loaded.packageRoot, stage.objectiveFile!), "utf8")
      : null,
    manifestValidation,
    selectedOpaqueCase: loaded.descriptor.selectedOpaqueCase ?? null,
    allOpaqueCases: [...(loaded.descriptor.allOpaqueCases ?? [])],
  };
}

export function prepareGoalExecutionStage(input: {
  packagePath: string;
  goalId: string;
  iteration: number;
  previousResultArtifactPath?: string | null;
  previousPatchArtifactPath?: string | null;
}): PreparedGoalStage {
  const loaded = readPackage(input.packagePath, input.goalId);
  const stage = stageFor(loaded.descriptor, input.iteration);
  let manifestPath = inside(loaded.packageRoot, stage.manifest);
  if (stage.handoff) {
    if (!input.previousResultArtifactPath) throw new Error(`${stage.name} is missing the previous result artifact`);
    if (stage.handoff.requirePatch && !input.previousPatchArtifactPath) {
      throw new Error(`${stage.name} is missing the previous immutable patch artifact`);
    }
    const manifest = structuredClone(loadManifest(manifestPath));
    const sourceRoot = realpathSync(manifest.source.projectRoot);
    const relation = relative(loaded.packageRoot, sourceRoot);
    if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error("Handoff manifest source must be contained in the goal package");
    }
    manifest.files = manifest.files.filter((file) => file.state !== "immutable-previous-stage-handoff");
    addArtifact(manifest, loaded.packageRoot, sourceRoot, input.previousResultArtifactPath, stage.handoff.resultDestination);
    if (input.previousPatchArtifactPath) {
      addArtifact(manifest, loaded.packageRoot, sourceRoot, input.previousPatchArtifactPath, stage.handoff.patchDestination);
    }
    manifestPath = inside(loaded.packageRoot, stage.handoff.generatedManifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  const manifestValidation = validateManifestSources(manifestPath);
  assertParticipantIsolation(loaded.descriptor, stage, manifestPath);
  return {
    packagePath: loaded.packagePath,
    stage,
    manifestPath,
    objectiveOverride: stage.objectiveMode === "fixed"
      ? readFileSync(inside(loaded.packageRoot, stage.objectiveFile!), "utf8")
      : null,
    manifestValidation,
    selectedOpaqueCase: loaded.descriptor.selectedOpaqueCase ?? null,
    allOpaqueCases: [...(loaded.descriptor.allOpaqueCases ?? [])],
  };
}

export function goalPackagePath(packagesRoot: string, goalId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(goalId)) throw new Error("goalId is invalid");
  return join(resolve(packagesRoot), goalId, "package.json");
}

export function packageExists(packagesRoot: string, goalId: string): boolean {
  return existsSync(goalPackagePath(packagesRoot, goalId));
}

function safeWorkspacePath(value: string): string {
  const normalized = safeRelative(value, "writable workspace path");
  const forbidden = new Set([".git"]);
  if (normalized.split("/").some((part) => forbidden.has(part.toLowerCase()))) {
    throw new Error(`Writable path is protected: ${value}`);
  }
  return normalized;
}

function filesBelow(root: string, relativePath: string): string[] {
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!existsSync(candidate)) return [];
  const item = lstatSync(candidate);
  if (item.isSymbolicLink()) throw new Error(`Writable path is a symbolic link: ${relativePath}`);
  if (item.isFile()) return [relativePath];
  if (!item.isDirectory()) throw new Error(`Writable path is not a file or directory: ${relativePath}`);
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Writable tree contains a symbolic link: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(safeWorkspacePath(relative(root, full).replaceAll("\\", "/")));
      else throw new Error(`Writable tree contains an unsupported filesystem object: ${full}`);
    }
  };
  visit(candidate);
  return found;
}

function withinApprovedPath(file: string, approved: string): boolean {
  return file === approved || file.startsWith(`${approved}/`);
}

export function refreshRepeatGoalPackage(input: {
  packagePath: string;
  goalId: string;
  writableWorkspacePaths: string[];
}): PreparedGoalStage {
  const loaded = readPackage(input.packagePath, input.goalId);
  if (loaded.descriptor.mode !== "repeat" || loaded.descriptor.stages.length !== 1) {
    throw new Error("Only a single-stage repeat goal package can be refreshed");
  }
  const stage = loaded.descriptor.stages[0];
  if (loaded.descriptor.developmentMode) {
    const manifestPath = inside(loaded.packageRoot, stage.manifest);
    const sourceRoot = loadManifest(manifestPath).source.projectRoot;
    writeDevelopmentManifest(sourceRoot, manifestPath);
    stage.manifestSha256 = sha256(manifestPath);
    writeFileSync(loaded.packagePath, `${JSON.stringify(loaded.descriptor, null, 2)}\n`);
    return inspectGoalExecutionPackage(loaded.packagePath, input.goalId, stage.iteration);
  }
  if (stage.role !== "development" || stage.allowedWritableWorkspacePaths !== "caller-bounded"
    || stage.objectiveMode !== "coordinator" || stage.handoff) {
    throw new Error("Repeat goal package refresh policy is invalid");
  }
  const approved = input.writableWorkspacePaths.map(safeWorkspacePath);
  if (new Set(approved).size !== approved.length) throw new Error("Writable workspace paths repeat");
  const manifestPath = inside(loaded.packageRoot, stage.manifest);
  const manifest = structuredClone(loadManifest(manifestPath));
  const sourceRoot = realpathSync(manifest.source.projectRoot);
  const byPath = new Map(manifest.files.map((item) => [item.path.replaceAll("\\", "/"), item]));
  for (const [path, item] of [...byPath]) {
    const full = resolve(sourceRoot, ...path.split("/"));
    if (!existsSync(full)) {
      if (!approved.some((allowed) => withinApprovedPath(path, allowed))) {
        throw new Error(`Unapproved source disappeared: ${path}`);
      }
      byPath.delete(path);
      continue;
    }
    const info = lstatSync(full);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source is not a regular file: ${path}`);
    const currentHash = sha256(full);
    if (currentHash !== item.sha256.toUpperCase()
      && !approved.some((allowed) => withinApprovedPath(path, allowed))) {
      throw new Error(`Unapproved source changed between iterations: ${path}`);
    }
    byPath.set(path, { ...item, bytes: info.size, sha256: currentHash, state: "goal-package-refreshed-source" });
  }
  for (const allowed of approved) {
    for (const path of filesBelow(sourceRoot, allowed)) {
      const full = resolve(sourceRoot, ...path.split("/"));
      const info = lstatSync(full);
      byPath.set(path, {
        path,
        bytes: info.size,
        sha256: sha256(full),
        state: "goal-package-refreshed-authorized-write",
      });
    }
  }
  if (byPath.size === 0) throw new Error("Repeat goal package cannot become empty");
  manifest.files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  manifest.source.baseRevision = execFileSync(
    "git",
    ["-c", `safe.directory=${sourceRoot}`, "-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  stage.manifestSha256 = sha256(manifestPath);
  writeFileSync(loaded.packagePath, `${JSON.stringify(loaded.descriptor, null, 2)}\n`, "utf8");
  return inspectGoalExecutionPackage(loaded.packagePath, input.goalId, stage.iteration);
}
