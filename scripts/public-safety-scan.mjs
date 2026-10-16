#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { loadPrivateTermPatterns } from "../plugins/amadeus/scripts/private-terms.mjs";

const root = resolve(process.argv[2] || process.cwd());
const exclusionSource = readFileSync(join(root, "src", "excluded-development-path.mjs"), "utf8");
const { excludedDevelopmentPath } = await import(
  `data:text/javascript;base64,${Buffer.from(exclusionSource, "utf8").toString("base64")}`
);
const allowedPatternSources = new Set([
  "plugins/amadeus/scripts/amadeus-runtime.mjs",
  "plugins/amadeus/scripts/state-migration.mjs",
  "plugins/amadeus/scripts/privacy-scan.mjs",
  "scripts/public-safety-scan.mjs",
  "scripts/run-privacy-scan-sandbox.mjs",
  "plugins/amadeus/scripts/private-terms.mjs",
  "claude-plugin/scripts/private-terms.mjs",
  "test/amadeus-branding.test.mjs",
]);
const textExtensions = new Set([".md", ".json", ".mjs", ".js", ".ts", ".yaml", ".yml", ".txt", ".ps1", ".toml"]);

function trackedFiles() {
  try {
    return execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/"))
      .filter((path) => !excludedDevelopmentPath(path));
  } catch {
    const found = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = relative(root, full).replaceAll("\\", "/");
        if (excludedDevelopmentPath(rel) || name === ".git" || name === "node_modules" || name === "verification") continue;
        if (statSync(full).isDirectory()) walk(full);
        else found.push(rel);
      }
    };
    walk(root);
    return found;
  }
}

function currentUserHomePatterns() {
  // Catch the scanning user's own home folder without naming anyone in source.
  let name = "";
  try { name = userInfo().username; } catch { name = process.env.USERNAME || process.env.USER || ""; }
  if (!/^[A-Za-z0-9._-]{2,}$/.test(name)) return [];
  const escaped = name.replaceAll(".", "\\.");
  return [
    // Any drive letter; single, JS-escaped double, or forward-slash separators.
    { id: "personal-windows-home", re: new RegExp(String.raw`[A-Za-z]:(?:\\{1,2}|/)Users(?:\\{1,2}|/)${escaped}\b`, "i") },
    { id: "personal-posix-home", re: new RegExp(String.raw`/(?:Users|home)/${escaped}\b`, "i") },
  ];
}
const patterns = [
  ...currentUserHomePatterns(),
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "token", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  // Owner-private names live in a local, git-ignored .private-terms.json.
  ...loadPrivateTermPatterns({ root }),
];
const forbiddenArtifact = /(?:^|\/)(?:coordinator\.sqlite(?:-.*)?|goal-packages|provider-registry\.json|registry\.json|benchmark(?:s)?\.json|execution-traces?)(?:\/|$)/i;
const findings = [];
const files = [...new Set(trackedFiles())].sort();
for (const path of files) {
  if (!existsSync(join(root, path)) || !textExtensions.has(extname(path).toLowerCase())) continue;
  if (forbiddenArtifact.test(path)) findings.push({ path, id: "private-runtime-artifact" });
  if (allowedPatternSources.has(path)) continue;
  const text = readFileSync(join(root, path), "utf8");
  for (const pattern of patterns) {
    if (pattern.re.test(text)) findings.push({ path, id: pattern.id });
  }
}
const result = { ok: findings.length === 0, root, filesScanned: files.length, findings };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

