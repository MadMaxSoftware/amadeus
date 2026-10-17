/**
 * Credentials must not reach model workers or the project commands they run.
 * Every worker gets an allowlist of host variables, never the whole host
 * environment: a denylist of credential-looking names misses secrets such as
 * DATABASE_URL and anything tools or users add later.
 * - Claude-style workers (Claude Code, Grok Build) need nothing from the host
 *   beyond process plumbing.
 * - Codex and Cursor workers run the project's developer tools directly, so they
 *   also keep the user's profile folders, temp folders and toolchain settings.
 */

/** Variable-name parts that mark a credential: GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY, ... */
const CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(?:_|$)/i;

/** Credentials whose names do not follow the pattern above. */
const CREDENTIAL_EXACT = new Set(["SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS", "NETRC"]);

export function isCredentialVariable(name: string): boolean {
  return CREDENTIAL_NAME.test(name) || CREDENTIAL_EXACT.has(name.toUpperCase());
}

/** The only host variables a Claude-style worker inherits: process plumbing. */
export const PROCESS_PLUMBING_VARIABLES: readonly string[] = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
  "OS", "NUMBER_OF_PROCESSORS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
  "PUBLIC", "ALLUSERSPROFILE", "USERDOMAIN",
];

/** Only the process-plumbing variables present in `source`. */
export function processPlumbingEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return pick(source, PROCESS_PLUMBING_VARIABLES);
}

/**
 * What Codex and Cursor workers, and the commands they run, inherit on top of process plumbing:
 * where the user's files and tools live, locale and terminal settings, and how to reach the
 * network (proxy and certificate settings; a proxy address that embeds a user name or password
 * is dropped). Overrides from the adapter (CODEX_HOME, NODE_OPTIONS, TEMP, ...) are applied after.
 */
export const DEVELOPER_TOOL_VARIABLES: readonly string[] = [
  ...PROCESS_PLUMBING_VARIABLES,
  // The user's profile and per-user folders: tool sign-ins, npm and pip caches, Git config.
  "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "USERNAME", "COMPUTERNAME", "SystemDrive",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  // Shells, locale and terminal.
  "PSModulePath", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR",
  // Codex's own home, when moved.
  "CODEX_HOME",
  // Toolchain locations.
  "JAVA_HOME", "GOROOT", "GOPATH", "GOBIN", "GOMODCACHE", "CARGO_HOME", "RUSTUP_HOME", "DOTNET_ROOT",
  "NVM_HOME", "NVM_SYMLINK", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL", "DENO_DIR", "PYENV", "PYENV_ROOT",
  "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_EXE", "PIPX_HOME", "UV_CACHE_DIR",
  // Network access through a proxy or a private certificate authority.
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
];

/** Locale categories (LC_ALL, LC_CTYPE, ...) are kept by prefix. */
const DEVELOPER_TOOL_PREFIXES = ["LC_"];

/** A proxy address with credentials in it, like http://user:password@proxy:8080. */
const PROXY_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;

/** The developer-tool variables present in `source`, without credentials. */
export function developerToolEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const prefixed = Object.keys(source).filter((name) => DEVELOPER_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)));
  return Object.fromEntries(Object.entries(pick(source, [...DEVELOPER_TOOL_VARIABLES, ...prefixed]))
    .filter(([name, value]) => !isCredentialVariable(name)
      && !(/proxy$/i.test(name) && PROXY_WITH_CREDENTIALS.test(String(value)))));
}

function pick(source: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]));
}
