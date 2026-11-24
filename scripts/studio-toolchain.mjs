import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { findProjectToolchain } from "../packages/aws-studio/cli/project-node.mjs";
import archives from "./studio-node-archives.json" with { type: "json" };

const windows = process.platform === "win32";

function managedNodeDirectory(version, env) {
  // Match the framework's discovery path so project workers and CLI commands find this pair too.
  const home = env.HOME || env.USERPROFILE || homedir();
  const data = windows ? env.LOCALAPPDATA || path.join(home, "AppData", "Local") : env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(data, "aws-studio", "node", version);
}

const nodeExecutable = directory => path.join(directory, ...(windows ? ["node.exe"] : ["bin", "node"]));

export async function findOrInstallToolchain(root, env = process.env) {
  try { return findProjectToolchain(root, env); }
  catch (error) {
    if (env.AWS_STUDIO_NODE !== undefined || error.code === "ENOENT") throw error;
    const version = readFileSync(path.join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
    const npmPin = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).packageManager;
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^npm@\d+\.\d+\.\d+$/.test(npmPin)) throw error;
    const archiveDirectory = `node-v${version}-${windows ? "win" : process.platform}-${process.arch}`;
    const name = archiveDirectory + (windows ? ".zip" : ".tar.gz");
    const expected = archives[name];
    if (!expected) throw error;
    if (env.npm_config_offline === "true") {
      throw new Error(`Node ${version} and ${npmPin} are unavailable locally. Connect to the internet for Studio's first run with this toolchain.`, { cause: error });
    }
    const destination = managedNodeDirectory(version, env);
    const select = directory => findProjectToolchain(root, { ...env, AWS_STUDIO_NODE: nodeExecutable(directory) });
    if (existsSync(destination)) {
      try { return select(destination); }
      catch (cause) { throw new Error(`The managed Node installation at ${destination} is unusable. Move it aside and run Studio again.`, { cause }); }
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    const staging = mkdtempSync(path.join(path.dirname(destination), `.node-v${version}-`));
    try {
      process.stderr.write(`Downloading Node ${version} with bundled npm for AWS Studio…\n`);
      const archive = path.join(staging, name);
      const response = await fetch(`https://nodejs.org/dist/v${version}/${name}`, { redirect: "error", signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`nodejs.org returned HTTP ${response.status}.`);
      const hash = createHash("sha256");
      await pipeline(response.body, async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(archive, { flags: "wx" }));
      if (hash.digest("hex") !== expected) throw new Error(`The SHA-256 checksum for ${name} did not match.`);
      // Windows' system tar supports ZIP, including when Git's GNU tar is earlier on PATH.
      const tar = windows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      execFileSync(tar, ["-xf", archive, "-C", staging], { env, stdio: "inherit", windowsHide: true });
      const extracted = path.join(staging, archiveDirectory);
      const installed = select(extracted);
      if (installed.version !== version || `npm@${installed.npmVersion}` !== npmPin) {
        throw new Error(`The downloaded archive must contain Node ${version} and ${npmPin}.`);
      }
      try { renameSync(extracted, destination); }
      catch (error) {
        // A concurrent launch may have finished installing this runtime.
        if (!existsSync(destination)) throw error;
      }
      return select(destination);
    } catch (error) {
      throw new Error(`Unable to prepare Node ${version} for AWS Studio. ${error.message}`, { cause: error });
    } finally {
      rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
