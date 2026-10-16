/**
 * Sandbox coverage for staging-path exclusions that keep PR-split mirrors and
 * tool caches out of worker patches (git diff --check / churn gates).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

const source = fs.readFileSync(path.join(root, "src", "excluded-development-path.mjs"), "utf8");
const { excludedDevelopmentPath } = await import(toDataUrl(source));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

await test("excludes PR-split mirrors, tool caches, and probe scripts", () => {
  for (const sample of [
    ".pr-split/manifest.json",
    ".pr-split/experimental-reporting/README.md",
    ".gitwork/README.md",
    ".tools/mingit/cmd/git.exe",
    "_tools/cache.bin",
    "_quarantine_host_only/tools-mingit-sandbox-copy/LICENSE.txt",
    ".pr1-9260f52/amadeus/README.md",
    ".tmp-pr1.zip",
    "_probe.mjs",
    "plugins/amadeus/_run-tests.mjs",
  ]) {
    assert.equal(excludedDevelopmentPath(sample), true, sample);
  }
});

await test("keeps release-path product files eligible", () => {
  for (const sample of [
    "plugins/amadeus/hooks/session-start.mjs",
    "docs/RELEASE_NOTES_0.3.8.md",
    "docs/RELEASE_NOTES_0.3.7.md",
    "docs/RELEASE_NOTES_0.3.2.md",
    "docs/LOCAL_MODEL_PILOT.md",
    "src/excluded-development-path.mjs",
    "test/amadeus-release.test.mjs",
    ".env.example",
  ]) {
    assert.equal(excludedDevelopmentPath(sample), false, sample);
  }
});

console.log(`\n# pass ${passed} fail ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
