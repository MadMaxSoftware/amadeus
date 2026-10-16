/**
 * Host entry for staging-path exclusions. Restricted sandboxes should use:
 *   scripts/run-excluded-path-tests-sandbox.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { excludedDevelopmentPath } from "../src/excluded-development-path.mjs";

test("excludes PR-split mirrors, tool caches, and probe scripts", () => {
  for (const sample of [
    ".pr-split/manifest.json",
    ".gitwork/README.md",
    ".tools/mingit/cmd/git.exe",
    "_quarantine_host_only/x",
    ".pr1-9260f52/tree/README.md",
    ".tmp-pr1.zip",
    "_probe.mjs",
    "plugins/amadeus/_run-tests.mjs",
  ]) {
    assert.equal(excludedDevelopmentPath(sample), true, sample);
  }
});

test("keeps release-path product files eligible", () => {
  for (const sample of [
    "plugins/amadeus/hooks/session-start.mjs",
    "docs/RELEASE_NOTES_0.3.8.md",
    "docs/RELEASE_NOTES_0.3.7.md",
    "docs/RELEASE_NOTES_0.3.2.md",
    "docs/LOCAL_MODEL_PILOT.md",
    "src/excluded-development-path.mjs",
    ".env.example",
  ]) {
    assert.equal(excludedDevelopmentPath(sample), false, sample);
  }
});
