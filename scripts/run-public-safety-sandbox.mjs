import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
for (const relative of ["scripts/public-safety-scan.mjs", "scripts/run-privacy-scan-sandbox.mjs"]) {
  const source = readFileSync(join(root, relative), "utf8").replace(/^#![^\n]*\n/, "");
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
