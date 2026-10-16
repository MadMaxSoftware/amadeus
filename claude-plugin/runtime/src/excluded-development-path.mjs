/**
 * Shared path exclusions for manifests, worker patches, and local diff-check.
 * Keep this plain ESM so sandbox tests can load it via data: URLs.
 */
export function excludedDevelopmentPath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  if (/^coordinator-state(?:\/|$)/i.test(normalized)) return true;
  if (/^(?:\.pr-split|\.gitwork|\.tools|_tools|_quarantine_host_only)(?:\/|$)/i.test(normalized)) return true;
  if (/(?:^|\/)(?:_probe|_run-tests)\.mjs$/i.test(normalized)) return true;
  if (/(?:^|\/)\.tmp[^/]*$/i.test(normalized)) return true;
  if (/(?:^|\/)\.pr1-[^/]+(?:\/|$)/i.test(normalized)) return true;
  return normalized.split("/").some((part) =>
    /^(\.git|\.tools|node_modules|\.venv|\.validator-deps|__pycache__|\.worker-isolation\.json|\.ssh|\.aws|\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(part)
    || (/^\.env(?:\.|$)/i.test(part) && !/^\.env\.(example|sample|template)$/i.test(part))
    || /^(credentials|auth)\.json$/i.test(part)
    || /\.(pem|pfx|p12|key)$/i.test(part));
}
