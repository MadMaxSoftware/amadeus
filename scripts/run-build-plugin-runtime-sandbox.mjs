import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const target = join(root, "plugins/amadeus/runtime");
const check = process.argv.includes("--check");
const files = ["package.json", ...["src", "config-templates"].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name).slice(root.length + 1).replaceAll("\\","/")))];
const manifest = {};
for (const file of files) {
  const content = readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n").trimEnd() + "\n";
  const dest = join(target, ...file.split("/"));
  manifest[file] = createHash("sha256").update(content).digest("hex");
  if (check) {
    const onDisk = readFileSync(dest, "utf8").replaceAll("\r\n", "\n");
    if (onDisk !== content) throw new Error("Stale packaged runtime: " + file);
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
if (check) {
  if (readFileSync(join(target, "manifest.json"), "utf8").replaceAll("\r\n", "\n") !== manifestText) {
    throw new Error("Stale runtime manifest");
  }
  const expected = new Set([...files, "manifest.json"]);
  for (const entry of readdirSync(target, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())) {
    const relative = join(entry.parentPath ?? entry.path, entry.name).slice(target.length + 1).replaceAll("\\", "/");
    if (!expected.has(relative)) throw new Error("Unexpected packaged runtime file: " + relative);
  }
} else {
  writeFileSync(join(target, "manifest.json"), manifestText);
}
console.log((check ? "Verified " : "Packaged ") + files.length + " runtime files.");
