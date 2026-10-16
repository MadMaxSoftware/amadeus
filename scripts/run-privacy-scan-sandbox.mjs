import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "plugins", "amadeus");
const SKIP_DIRS = new Set([".git", "node_modules", "assets"]);
const SKIP_FILES = new Set([
  "amadeus-runtime.mjs",
  "privacy-scan.mjs",
  "server.test.mjs",
]);
const TEXT_EXT = new Set([
  ".md", ".json", ".mjs", ".js", ".ts", ".yaml", ".yml", ".txt", ".ps1", ".example",
]);
// Owner-private terms come from the local, git-ignored .private-terms.json (inlined
// here because this runner is piped into a sandboxed node without module imports).
const termsFile = process.env.AMADEUS_PRIVATE_TERMS_FILE || path.join(process.cwd(), ".private-terms.json");
const privateTerms = fs.existsSync(termsFile) ? JSON.parse(fs.readFileSync(termsFile, "utf8")) : [];
const escapeTerm = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = [
  { id: "fixed-nodejs-path", re: /C:\/Program Files\/nodejs\/node\.exe/i },
  ...privateTerms.map((term, index) => ({ id: `private-term-${index + 1}`,
    re: new RegExp(String(term).split(/[\s_-]+/).filter(Boolean).map(escapeTerm).join("[\\s_-]*"), "i") })),
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (!SKIP_FILES.has(name)) out.push(full);
  }
  return out;
}

function isText(filePath) {
  const lower = filePath.toLowerCase();
  return [...TEXT_EXT].some((ext) => lower.endsWith(ext)) || lower.endsWith("skill.md");
}

const files = walk(root).filter(isText);
const findings = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /sk-[a-zA-Z0-9]{20,}/.test(text)) {
    findings.push({ file: path.relative(root, file), id: "credential-or-token" });
  }
  for (const { id, re } of patterns) {
    const match = text.match(re);
    if (match) findings.push({ file: path.relative(root, file), id, sample: match[0] });
  }
}

const result = { ok: findings.length === 0, scannedFiles: files.length, findings };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
