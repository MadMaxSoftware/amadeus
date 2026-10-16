#!/usr/bin/env node
/**
 * Sandbox-friendly stand-in for `git diff --check` when Git getcwd is blocked.
 * Flags conflict markers, trailing ASCII whitespace, and space-before-tab on
 * text files under the workspace (honors worker patch staging-path exclusions).
 * Exit 2 matches git diff --check on findings.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

const exclusionSource = readFileSync(join(root, "src", "excluded-development-path.mjs"), "utf8");
const { excludedDevelopmentPath } = await import(toDataUrl(exclusionSource));

function excluded(relPosix) {
  return excludedDevelopmentPath(relPosix)
    || relPosix.split("/").some((part) => part === ".git");
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192);
  let nul = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) nul++;
  return nul > 2;
}

const issues = [];
function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    const rel = relative(root, full).split(sep).join("/");
    if (excluded(rel)) continue;
    if (name.isDirectory()) {
      walk(full);
      continue;
    }
    if (!name.isFile()) continue;
    const buf = readFileSync(full);
    if (isProbablyBinary(buf)) continue;
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, "");
      if (/[ \t]+$/.test(line)) issues.push(`${rel}:${i + 1}: trailing whitespace`);
      if (/^ +\t/.test(line)) issues.push(`${rel}:${i + 1}: space before tab`);
      if (/^(<<<<<<<|>>>>>>>|=======)(?:\s|$)/.test(line)) issues.push(`${rel}:${i + 1}: conflict marker`);
    }
  }
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`workspace-diff-check: not a directory: ${root}`);
  process.exit(2);
}

walk(root);
if (issues.length) {
  for (const issue of issues.slice(0, 200)) console.error(issue);
  if (issues.length > 200) console.error(`... and ${issues.length - 200} more`);
  process.exit(2);
}
console.log("workspace-diff-check: clean");
process.exit(0);
