import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const privateTermsSource = readFileSync(join(root, "plugins/amadeus/scripts/private-terms.mjs"), "utf8");
const privateTermsUrl = `data:text/javascript;base64,${Buffer.from(privateTermsSource).toString("base64")}`;
for (const relative of ["scripts/public-safety-scan.mjs", "scripts/run-privacy-scan-sandbox.mjs"]) {
  const source = readFileSync(join(root, relative), "utf8")
    .replace(/^#![^\n]*\n/, "")
    .replace('"../plugins/amadeus/scripts/private-terms.mjs"', JSON.stringify(privateTermsUrl));
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
