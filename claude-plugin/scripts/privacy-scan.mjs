#!/usr/bin/env node
/**
 * Privacy-release validation for Amadeus distributable surfaces.
 * Fails if personal paths, private project names, credentials, or fixed
 * machine node paths appear in packaged artifacts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AMADEUS_PRODUCT, PRIVACY_BANNED_PATTERNS } from "./amadeus-runtime.mjs";

const pluginRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = process.argv[2] ? resolve(process.argv[2]) : pluginRoot;

const SKIP_DIRS = new Set([".git", "node_modules", "assets"]);
const SKIP_FILES = new Set([
  // Pattern catalogs and tests intentionally mention banned shapes for detection.
  "amadeus-runtime.mjs",
  "privacy-scan.mjs",
  "private-terms.mjs",
  "server.test.mjs",
]);
const TEXT_EXT = new Set([
  ".md", ".json", ".mjs", ".js", ".ts", ".yaml", ".yml", ".txt", ".ps1", ".example",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (!SKIP_FILES.has(name)) out.push(path);
  }
  return out;
}

function isText(path) {
  const lower = path.toLowerCase();
  return [...TEXT_EXT].some((ext) => lower.endsWith(ext)) || lower.endsWith("skill.md");
}

const files = walk(root).filter(isText);
const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  // Credentials / token-shaped secrets
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /sk-[a-zA-Z0-9]{20,}/.test(text)) {
    findings.push({ file: relative(root, file), id: "credential-or-token", sample: "redacted" });
  }
  if (/coordinator\.sqlite|goal-packages|completionAudit|saved.?history/i.test(relative(root, file))
    && /\.sqlite$|\.jsonl$/i.test(file)) {
    findings.push({ file: relative(root, file), id: "runtime-state-artifact", sample: relative(root, file) });
  }
  for (const { id, re } of PRIVACY_BANNED_PATTERNS) {
    const match = text.match(re);
    if (match) findings.push({ file: relative(root, file), id, sample: match[0] });
  }
}

const identity = {
  pluginName: AMADEUS_PRODUCT.pluginName,
  displayName: AMADEUS_PRODUCT.displayName,
  descriptor: AMADEUS_PRODUCT.descriptor,
  publisher: AMADEUS_PRODUCT.publisher,
  personalityAlias: AMADEUS_PRODUCT.personalityAlias,
};

const result = {
  ok: findings.length === 0,
  root,
  filesScanned: files.length,
  identity,
  findings,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
