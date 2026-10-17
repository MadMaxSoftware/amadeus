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

/**
 * The only host variables a Claude-style worker (Claude Code, Grok Build)
 * inherits: process plumbing. A denylist of known keys misses credentials added
 * by other tools and user-defined variables, so these CLIs, which need nothing
 * else from the host, get an allowlist. Codex and Cursor workers still inherit
 * the host environment minus credentials (withoutCredentials), because the
 * developer tools they run need it; moving them to an allowlist is open item H9.
 */
export const PROCESS_PLUMBING_VARIABLES: readonly string[] = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
  "OS", "NUMBER_OF_PROCESSORS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
  "PUBLIC", "ALLUSERSPROFILE", "USERDOMAIN",
];

/** Only the process-plumbing variables present in `source`. */
export function processPlumbingEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(PROCESS_PLUMBING_VARIABLES.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
