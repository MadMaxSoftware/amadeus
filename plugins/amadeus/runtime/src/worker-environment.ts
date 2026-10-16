/**
 * Credentials must not reach model workers or the project commands they run.
 * Codex and Cursor workers inherit the host environment so that ordinary
 * developer tools keep working; this removes anything that looks like a secret.
 * (The Claude adapter goes further and passes an explicit allowlist.)
 */

/** Variable-name parts that mark a credential: GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY, ... */
const CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(?:_|$)/i;

/** Credentials whose names do not follow the pattern above. */
const CREDENTIAL_EXACT = new Set(["SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS", "NETRC"]);

export function isCredentialVariable(name: string): boolean {
  return CREDENTIAL_NAME.test(name) || CREDENTIAL_EXACT.has(name.toUpperCase());
}

/** A copy of the environment with credential variables removed. */
export function withoutCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !isCredentialVariable(name)));
}
