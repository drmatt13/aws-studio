import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { ProjectToolchain } from "aws-studio/cli/project-node.mjs";

interface MachImage { libraries: string[]; rpaths: string[] }
export function parseMachImage(libraries: string, loadCommands: string): MachImage {
  const names = libraries.split("\n").slice(1).map(line => /^\s+(.+?) \(compatibility version/.exec(line)?.[1]).filter((value): value is string => !!value);
  const rpaths = [...loadCommands.matchAll(/cmd LC_RPATH\r?\n\s+cmdsize \d+\r?\n\s+path (.+?) \(offset \d+\)/g)].map(match => match[1]);
  return { libraries: names, rpaths };
}

function inspect(file: string, args: string[]): string {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" }, windowsHide: true });
  if (result.error || result.status !== 0) {
    // Fixed trusted tools inspect binary metadata only. Report OS classifications
    // to distinguish contention/timeouts from denied execution, without raw
    // stderr, library paths or inherited configuration contents.
    const code = result.error && "code" in result.error && typeof result.error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(result.error.code) ? result.error.code : "none";
    const signal = result.signal && /^SIG[A-Z0-9]{1,20}$/.test(result.signal) ? result.signal : "none";
    throw new Error(`Cannot inspect Node toolchain (${path.basename(file)}; code=${code}; exit=${result.status ?? "none"}; signal=${signal}). Coding remains disabled.`);
  }
  return result.stdout;
}

let cached: { key: string; paths: string[] } | undefined;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const runtimeNode = (directory: string): string => path.join(directory, process.platform === "win32" ? "node.exe" : "node");

/** Check every host read grant, including lexical aliases, without replacing the
 * specific package aliases required by native dynamic-library loaders.
 */
export function assertNarrowReadPaths(paths: readonly string[], message = "Broad host runtime read grants are prohibited."): void {
  // Windows exposes the same paths with and without an extended namespace.
  // Compare both spellings with native path semantics (including drive case).
  const normalize = (value: string) => path.resolve(process.platform === "win32"
    ? value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[a-z]:\\)/i, "") : value);
  // The native account home can differ from redirected launcher home values.
  let accountHome: string | undefined;
  try { accountHome = userInfo().homedir; }
  catch (error) {
    const failure = error as { code?: string; info?: { code?: string; syscall?: string } };
    // UID-only Linux containers can have no passwd entry. Other lookup failures,
    // and unavailable native Windows/macOS account identities, remain closed.
    if (process.platform !== "linux" || failure.code !== "ERR_SYSTEM_ERROR" || failure.info?.code !== "ENOENT" || failure.info.syscall !== "uv_os_get_passwd") throw error;
  }
  const protectedPaths = [process.cwd(), homedir(), accountHome, process.env.HOME, ...(process.platform === "win32" ? [process.env.USERPROFILE] : [])]
    .filter((value): value is string => !!value && path.isAbsolute(value)).flatMap(value => {
      const lexical = normalize(value);
      try { return [lexical, normalize(realpathSync(value))]; }
      catch (error) {
        // A stale optional home variable can name a directory that no longer
        // exists. Retain its lexical boundary; other resolution failures close.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [lexical];
        throw error;
      }
    });
  // String canonicalization can preserve component case on case-insensitive
  // volumes. Directory identities catch those aliases without folding case on
  // case-sensitive volumes; ancestor identities also reject broad parent grants.
  const protectedIdentities = new Set<string>(), inspected = new Set<string>();
  for (const protectedPath of protectedPaths) {
    let ancestor = protectedPath;
    while (!inspected.has(ancestor)) {
      inspected.add(ancestor);
      try {
        const stat = statSync(ancestor, { bigint: true });
        if (stat.isDirectory()) protectedIdentities.add(`${stat.dev}:${stat.ino}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  const broad = (directory: string) => directory === path.parse(directory).root || protectedPaths.some(protectedPath => {
    const relative = path.relative(directory, protectedPath);
    return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  for (const value of paths) {
    if (!path.isAbsolute(value)) throw new Error("Trusted runtime read paths must be absolute.");
    // Reject obvious roots before resolving them, including UNC share roots.
    if (broad(normalize(value)) || broad(normalize(realpathSync(value)))) throw new Error(message);
    const stat = statSync(value, { bigint: true });
    if (protectedIdentities.has(`${stat.dev}:${stat.ino}`)) throw new Error(message);
  }
}

/** Use an absolute system shell, never one supplied by candidate source or PATH. */
export function trustedShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("The Windows system directory is unavailable.");
    const file = realpathSync(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"));
    return { file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] };
  }
  const file = realpathSync(process.platform === "darwin" ? "/private/var/select/sh" : "/bin/sh");
  if (!/^\/(?:usr\/)?bin\/[^/]+$/.test(file)) throw new Error("Trusted system shell is unavailable.");
  return { file, args: ["-c"] };
}

/** Read-only launchers re-establish audited dyld paths after SIP-protected shells
 * strip DYLD_* variables. They live outside both candidate and writable scratch.
 */
export function createToolchainLaunchers(scratchDir: string, readPaths: string[], toolchain?: ProjectToolchain): { directory: string; environment: Record<string, string> } {
  const directory = mkdtempSync(path.join(path.dirname(scratchDir), "provider-runtime-"));
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("The Windows system directory is unavailable.");
    const npm = toolchain?.npm ?? installedNpm().entry, node = runtimeNode(directory);
    copyFileSync(realpathSync(toolchain?.node ?? process.execPath), node);
    // JS realpath lstat()s the drive root even when the requested file has a
    // narrow read grant. Win32's native implementation resolves the allowed
    // file directly while retaining OS access checks. Preload before config
    // loaders and test discovery, including their child Node processes.
    const realpath = Buffer.from(`import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";\nfor (const name of ["realpath", "realpathSync"]) { const native = fs[name].native; native.native = native; fs[name] = native; }\nsyncBuiltinESMExports();\n`).toString("base64");
    // npm scripts use cmd.exe on Windows; the interactive tool uses PowerShell.
    // Reject cmd expansion characters in host-selected launcher paths rather
    // than allowing a path to become executable batch syntax.
    if (/[\r\n%!"]/.test(node + npm)) throw new Error("The installed Windows toolchain path cannot be represented safely in an npm launcher.");
    writeFileSync(path.join(directory, "npm.cmd"), `@"${node}" "${npm}" %*\r\n`, { flag: "wx" });
    writeFileSync(path.join(directory, "npm.ps1"), `& '${node.replaceAll("'", "''")}' '${npm.replaceAll("'", "''")}' @args\nexit $LASTEXITCODE\n`, { flag: "wx" });
    return { directory, environment: { PATH: [directory, process.env.PATH ?? "", path.join(systemRoot, "System32"), path.dirname(trustedShell().file)].filter(Boolean).join(path.delimiter),
      SystemRoot: systemRoot, SYSTEMROOT: systemRoot, ComSpec: realpathSync(path.join(systemRoot, "System32/cmd.exe")), OPENSSL_CONF: "NUL",
      // Main resolution precedes preloads. Dependencies must still canonicalize:
      // preserving every junction creates duplicate GraphQL class instances.
      // A data preload needs no filesystem lookup before native realpath is ready.
      NODE_OPTIONS: `--preserve-symlinks-main --import=data:text/javascript;base64,${realpath}`,
      npm_config_script_shell: realpathSync(path.join(systemRoot, "System32/cmd.exe")), npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" } };
  }
  const libraryPaths = [...new Set(readPaths.map(value => realpathSync(value)))];
  // macOS /bin/sh consults an extra selector symlink before loading its shell.
  // Use the inspected system executable directly, without granting /var reads.
  const shell = realpathSync(process.platform === "darwin" ? "/private/var/select/sh" : "/bin/sh");
  if (!shell.startsWith("/bin/") && !shell.startsWith("/usr/bin/")) throw new Error("The system shell resolves outside trusted platform binaries.");
  const environment: Record<string, string> = { PATH: [directory, process.env.PATH ?? "/usr/bin:/bin"].join(path.delimiter), OPENSSL_CONF: "/dev/null",
    npm_config_script_shell: shell, npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
  if (process.platform === "darwin") environment.DYLD_LIBRARY_PATH = libraryPaths.join(path.delimiter);
  const exports = Object.entries(environment).filter(([key]) => key !== "PATH").map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  const node = realpathSync(toolchain?.node ?? process.execPath), npm = toolchain?.npm ?? installedNpm().entry;
  for (const [name, prefix] of [["node", []], ["npm", [npm]]] as const) {
    writeFileSync(path.join(directory, name), `#!${shell}\n${exports}\nexec ${[node, ...prefix].map(shellQuote).join(" ")} "$@"\n`, { flag: "wx", mode: 0o500 });
  }
  chmodSync(directory, 0o700);
  return { directory, environment };
}
export function installedNpm(): { entry: string; directory: string } {
  const nodeBin = path.dirname(realpathSync(process.execPath));
  // Keep validation on the npm installation that launched Studio. A machine
  // can have another npm beside Node with a different supported major version.
  const candidates = [process.env.npm_execpath, path.join(nodeBin, "npm"), path.join(nodeBin, "node_modules/npm/bin/npm-cli.js"), path.join(nodeBin, "../lib/node_modules/npm/bin/npm-cli.js"),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(item => path.isAbsolute(item)).map(item => path.join(item, "npm"))].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    try {
      const entry = realpathSync(candidate);
      if (path.basename(entry) !== "npm-cli.js") continue;
      const directory = path.dirname(path.dirname(entry));
      const relative = path.relative(realpathSync(process.cwd()), directory);
      if (!relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) continue;
      if (JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name !== "npm") continue;
      return { entry, directory };
    } catch { /* Try the next installed executable. */ }
  }
  throw new Error("An installed npm CLI outside project source is required for validation.");
}
/** Inspect only the trusted Node executable already running Studio, never candidate binaries.
 * Dynamic libraries remain read-only. No PATH directory or whole Homebrew prefix is granted.
 */
export function nodeToolchainReadPaths(executable = process.execPath, platform = process.platform): string[] {
  const canonical = realpathSync(executable), stat = statSync(canonical);
  const key = `${platform}:${path.resolve(executable)}:${canonical}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (cached?.key === key) {
    assertNarrowReadPaths(cached.paths, "Unsafe Node toolchain read root.");
    return [...cached.paths];
  }
  const paths = new Set([path.dirname(canonical), path.dirname(path.resolve(executable))]);
  const addLibraryPath = (file: string, resolved: string) => {
    paths.add(path.dirname(file)); paths.add(path.dirname(resolved));
    let ancestor = path.dirname(file);
    while (ancestor !== path.dirname(ancestor)) {
      if (lstatSync(ancestor).isSymbolicLink()) {
        const target = realpathSync(ancestor), relative = path.relative(target, resolved);
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
          throw new Error("A toolchain symlink does not lead to its inspected library.");
        // Grant the specific installed package alias, never every package in opt/.
        paths.add(ancestor);
      }
      ancestor = path.dirname(ancestor);
    }
  };
  if (platform === "darwin") {
    const inspected = new Set<string>();
    const executableDirectory = path.dirname(canonical);
    const expand = (value: string, owner: string) => value.replace(/^@loader_path(?=\/|$)/, path.dirname(owner)).replace(/^@executable_path(?=\/|$)/, executableDirectory);
    const visit = (file: string, inheritedRpaths: string[]) => {
      if (file.startsWith("/usr/lib/") || file.startsWith("/System/Library/")) return; // macOS shared cache; covered by minimal platform policy.
      const resolved = realpathSync(file);
      addLibraryPath(file, resolved);
      if (inspected.has(resolved)) return;
      if (inspected.size >= 256) throw new Error("The Node dynamic library closure exceeds the sandbox policy limit.");
      inspected.add(resolved);
      const image = parseMachImage(inspect("/usr/bin/otool", ["-L", resolved]), inspect("/usr/bin/otool", ["-l", resolved]));
      const rpaths = [...image.rpaths.map(value => expand(value, resolved)), ...inheritedRpaths];
      for (const library of image.libraries) {
        let target = expand(library, resolved);
        if (target.startsWith("@rpath/")) {
          const suffix = target.slice(7);
          const found = rpaths.map(root => path.resolve(root, suffix)).find(candidate => existsSync(candidate));
          if (!found) throw new Error("A Node dynamic library cannot be resolved without broad filesystem access.");
          target = found;
        }
        if (!path.isAbsolute(target)) throw new Error("The Node toolchain contains an unsupported dynamic library reference.");
        visit(target, rpaths);
      }
    };
    visit(canonical, []);
  } else if (platform === "linux") {
    const result = spawnSync("/usr/bin/ldd", [canonical], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0 && !/not a dynamic executable|statically linked/.test(result.stdout + result.stderr)) throw new Error("Cannot inspect Node's Linux runtime libraries.");
    for (const line of result.stdout.split("\n")) {
      const library = /(?:=>\s+|^\s*)(\/\S+)\s+\(/.exec(line)?.[1];
      if (library) addLibraryPath(library, realpathSync(library));
      if (/=>\s+not found/.test(line)) throw new Error("The installed Node toolchain has a missing runtime library.");
    }
  }
  const sorted = [...paths].sort();
  // A malformed toolchain must not accidentally grant the host filesystem.
  assertNarrowReadPaths(sorted, "Unsafe Node toolchain read root.");
  cached = { key, paths: sorted };
  return [...sorted];
}
