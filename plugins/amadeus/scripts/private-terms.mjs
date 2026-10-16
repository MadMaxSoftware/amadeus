/**
 * Owner-private terms for leak scanning.
 *
 * Private project names, personal paths and similar terms never appear in the
 * public package. The owner lists them in a local, git-ignored JSON file
 * (an array of strings), named by AMADEUS_PRIVATE_TERMS_FILE or found as
 * `.private-terms.json` at the repository root. Without that file only the
 * generic leak rules apply.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PRIVATE_TERMS_FILE_NAME = ".private-terms.json";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a term case-insensitively, tolerating space, hyphen or underscore between its words. */
export function privateTermPattern(term) {
  const parts = String(term).split(/[\s_-]+/).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return null;
  return new RegExp(parts.join("[\\s_-]*"), "i");
}

export function privateTermsFile(options = {}) {
  const env = options.env ?? process.env;
  if (env.AMADEUS_PRIVATE_TERMS_FILE?.trim()) return resolve(env.AMADEUS_PRIVATE_TERMS_FILE.trim());
  if (options.root) return join(resolve(options.root), PRIVATE_TERMS_FILE_NAME);
  if (!options.searchFrom) return null;
  // Packaged scripts sit two or three folders below the repository root.
  let dir = resolve(options.searchFrom);
  for (let depth = 0; depth < 4; depth++) {
    const candidate = join(dir, PRIVATE_TERMS_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/** Load owner-private term patterns; returns [] when no terms file is configured. */
export function loadPrivateTermPatterns(options = {}) {
  const file = privateTermsFile(options);
  if (!file || !existsSync(file)) return [];
  const terms = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(terms)) throw new Error(`${PRIVATE_TERMS_FILE_NAME} must contain a JSON array of strings`);
  return terms.map((term, index) => ({ id: `private-term-${index + 1}`, re: privateTermPattern(term) }))
    .filter((pattern) => pattern.re);
}
