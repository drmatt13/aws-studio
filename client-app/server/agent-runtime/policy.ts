import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentProvider } from "./providers/types";
import { assertNarrowReadPaths, createToolchainLaunchers, installedNpm, nodeToolchainReadPaths } from "./providers/toolchain";
import type { ProjectToolchain } from "aws-studio/cli/project-node.mjs";

export interface ExecutionPolicy { cwd: string; scratchDir: string; profile: string; environment: NodeJS.ProcessEnv; commandEnvironment: Record<string, string>; runtimeDirectory: string; config: Record<string, unknown>; toolchainReadPaths: string[]; readOnlyCwd?: boolean }
export interface PolicyOptions { readOnlyCwd?: boolean; readPaths?: string[]; toolchain?: ProjectToolchain }

/** Windows has no shebang execution. Only a Node shebang selects the trusted
 * current Node; cmd/PowerShell/batch shims are never interpreted as commands.
 */
export function providerLaunch(file: string, args: readonly string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && path.extname(file).toLowerCase() !== ".exe") {
    const descriptor = openSync(file, "r");
    let first: string;
    try { const bytes = Buffer.alloc(4096); first = bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString("utf8").split(/\r?\n/, 1)[0]!; }
    finally { closeSync(descriptor); }
    if (first !== `#!${process.execPath}` && first !== "#!/usr/bin/env node") throw new Error("The provider CLI requires a native executable or a standalone Node entry point.");
    return { file: process.execPath, args: [file, ...args] };
  }
  return { file, args: [...args] };
}

export function providerExecutable(provider: AgentProvider, env = process.env): string {
  const directories = (env.PATH ?? "").split(path.delimiter).filter(value => path.isAbsolute(value));
  if (env.HOME) directories.push(path.join(env.HOME, ".local/bin"));
  if (process.platform === "win32" && !env.HOME && env.USERPROFILE) directories.push(path.join(env.USERPROFILE, ".local/bin"));
  for (const directory of directories) {
    const candidates = process.platform === "win32" ? [path.join(directory, `${provider}.exe`), path.join(directory, provider)] : [path.join(directory, provider)];
    if (process.platform === "win32" && provider === "codex" && ["x64", "arm64"].includes(process.arch)) {
      // npm installs a .cmd/.ps1 shim, which cannot be spawned with shell:false.
      // Resolve only the official package's native executable; never execute or
      // parse the shim as a shell program.
      const packageRoot = path.join(directory, "node_modules/@openai/codex");
      try {
        if (JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).name !== "@openai/codex") throw new Error("Unexpected CLI package.");
        const triple = `${process.arch === "x64" ? "x86_64" : "aarch64"}-pc-windows-msvc`;
        const require = createRequire(path.join(packageRoot, "package.json"));
        try { candidates.push(path.join(path.dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`)), "vendor", triple, "bin/codex.exe")); } catch { /* Older packages embed vendor. */ }
        candidates.push(path.join(packageRoot, "vendor", triple, "bin/codex.exe"));
      } catch { /* A native standalone install does not need npm metadata. */ }
    }
    for (const candidate of candidates) {
      try {
        const file = realpathSync(candidate);
        if (/(?:^|[\\/])(?:\.vscode(?:-insiders)?|\.cursor|\.windsurf)[\\/]extensions[\\/]/.test(file)) continue;
        accessSync(file, constants.X_OK);
        if (lstatSync(file).isFile()) { providerLaunch(file, []); return file; }
      } catch { /* Try the next standalone install. */ }
    }
  }
  throw new Error(`Standalone ${provider} CLI is unavailable. Sign in through its terminal application first.`);
}

/** CLI owns saved authentication. Never copy tokens or inherit AWS/application secrets. */
export function providerEnvironment(scratchDir: string, source = process.env): NodeJS.ProcessEnv {
  // Candidate commands must not load host OpenSSL engines/configuration. The
  // default providers work without it; no network/TLS verification is bypassed.
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir, OPENSSL_CONF: process.platform === "win32" ? "NUL" : "/dev/null" };
  for (const key of ["PATH", "HOME", "USER", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "LANG", "CODEX_HOME", "CLAUDE_CONFIG_DIR", ...(process.platform === "win32" ? ["APPDATA", "LOCALAPPDATA"] : [])])
    if (source[key]) env[key] = source[key];
  return env;
}

export function executionPolicy(cwd: string, scratchDir: string, options: PolicyOptions = {}): ExecutionPolicy {
  if (!["darwin", "linux", "win32"].includes(process.platform)) throw new Error("Coding execution requires a verified macOS, Linux or Windows MXC sandbox.");
  cwd = realpathSync(cwd);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  scratchDir = realpathSync(scratchDir);
  if (cwd === scratchDir || scratchDir.startsWith(`${cwd}${path.sep}`)) throw new Error("Provider scratch storage must be outside candidate source.");
  const profile = `studio_${randomUUID().replaceAll("-", "")}`;
  const filesystem: Record<string, unknown> = { ":minimal": "read", [cwd]: options.readOnlyCwd ? "read" : "write", [scratchDir]: "write" };
  assertNarrowReadPaths(options.readPaths ?? []);
  const extra = (options.readPaths ?? []).map(value => realpathSync(value));
  const nodeReads = nodeToolchainReadPaths(options.toolchain?.node);
  const npmDirectory = options.toolchain ? path.dirname(path.dirname(options.toolchain.npm)) : installedNpm().directory;
  assertNarrowReadPaths([...nodeReads, npmDirectory, ...extra]);
  const runtime = createToolchainLaunchers(scratchDir, nodeReads, options.toolchain);
  const commandEnvironment = { ...runtime.environment, HOME: scratchDir, ...(process.platform === "win32" ? { USERPROFILE: scratchDir, APPDATA: scratchDir, LOCALAPPDATA: scratchDir } : {}), TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir, LANG: "en_US.UTF-8" };
  const toolchainReadPaths = [...nodeReads, npmDirectory, runtime.directory, ...extra];
  try { assertNarrowReadPaths(toolchainReadPaths); }
  catch (error) { rmSync(runtime.directory, { recursive: true, force: true }); throw error; }
  for (const directory of toolchainReadPaths) filesystem[directory] = "read";
  for (const relative of [".git", ".codex", ".claude", ".mcp.json"]) filesystem[path.join(cwd, relative)] = "deny";
  return { cwd, scratchDir, profile, environment: { ...providerEnvironment(scratchDir), PATH: runtime.environment.PATH }, commandEnvironment, runtimeDirectory: runtime.directory, toolchainReadPaths, readOnlyCwd: options.readOnlyCwd, config: {
    default_permissions: profile,
    permissions: { [profile]: { filesystem, network: { enabled: false } } },
    approval_policy: "never", approvals_reviewer: "user", web_search: "disabled",
    // Explicit selection fails if MXC is unavailable; no weaker Windows token
    // sandbox or unrestricted fallback can execute a candidate command.
    ...(process.platform === "win32" ? { windows: { sandbox: "mxc" } } : {}),
    mcp_servers: {}, hooks: {}, notify: [], features: { mcp_connection_sharing: false },
    shell_environment_policy: { inherit: "none", set: commandEnvironment },
  } };
}

export const DISABLED_CODEX_FEATURES = ["hooks", "apps", "enable_mcp_apps", "plugins", "remote_plugin", "skill_mcp_dependency_install",
  "multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools", "memories", "shell_snapshot", "goals", "web_search_request", "web_search_cached",
  "computer_use", "browser_use", "in_app_browser", "browser_use_external", "browser_use_full_cdp_access"];

/** TOML inline values, never shell strings. */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${tomlValue(entry)}`).join(",")}}`;
  throw new Error("Unsupported provider configuration value.");
}

export function codexArguments(policy: ExecutionPolicy) {
  return ["app-server", "--listen", "stdio://", ...Object.entries(policy.config).flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]),
    ...DISABLED_CODEX_FEATURES.flatMap(feature => ["--disable", feature])];
}

export function claudeArguments(policy: ExecutionPolicy, model?: string, sessionId?: string) {
  const settings = {
    disableAllHooks: true,
    permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, excludedCommands: [], autoAllowBashIfSandboxed: false,
      filesystem: { denyRead: ["/"], allowRead: [policy.cwd, policy.scratchDir, "/usr", "/bin", "/System/Library", "/Library/Apple", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", ...policy.toolchainReadPaths], allowWrite: [...(policy.readOnlyCwd ? [] : [policy.cwd]), policy.scratchDir], denyWrite: [...(policy.readOnlyCwd ? [policy.cwd] : []), ...[".git", ".codex", ".claude", ".mcp.json"].map(name => path.join(policy.cwd, name))] },
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] } },
  };
  // Native Claude Bash permits macOS credential Mach services; native file
  // tools also bypass the shell boundary. Expose only the host's fixed SDK MCP.
  return ["--safe-mode", "--restricted", "--add-dir", policy.scratchDir, "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{"studio_shell":{"type":"sdk","name":"studio_shell"}}}',
    "--setting-sources", "", "--settings", JSON.stringify(settings), "--permission-mode", "manual", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-chrome",
    ...(model ? [`--model=${model}`] : []), ...(sessionId ? [`--resume=${sessionId}`] : []), "-p"];
}
