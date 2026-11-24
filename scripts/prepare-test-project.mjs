import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generatedPeerName, generatedPeerPath, platformRoot, publicStarterPath, readStarterFiles, readStarterSelection, writeStarterFiles } from "./test-project-source.mjs";

const hash = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const json = (root, name) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
const writeJson = (root, name, data) => writeFileSync(path.join(root, name), JSON.stringify(data, null, 2) + "\n");
const cdkFile = "cdk-app/cdk.json";
const productionTargets = { prod: { mode: "prod", account: "222233334444", region: "us-east-1", inputs: "cdk-app/.env.prod" } };

function npmEnvironment(runtime, tools, env) {
  const cleaned = runtime.projectToolchainEnv(tools, env);
  for (const key of Object.keys(cleaned)) {
    if (/^(?:npm_config_(?:workspace|workspaces|global|prefix|include_workspace_root|ignore_scripts)|FRAMEWORK_REPOSITORY_ROOT|FRAMEWORK_STUDIO_STATE_DIRECTORY|FRAMEWORK_EXPORT_DIRECTORY|FRAMEWORK_INPUTS_FILE|STUDIO_PROJECT)$/i.test(key)) {
      delete cleaned[key];
    }
  }
  return {
    ...cleaned,
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    AWS_EC2_METADATA_DISABLED: "true",
    CHECKPOINT_DISABLE: "1",
  };
}

function checkRelease(root, version) {
  const release = path.join(root, "node_modules/aws-studio");
  if (!lstatSync(release).isDirectory() || realpathSync(release) !== release || json(release, "package.json").version !== version) {
    throw new Error("The test application must install its own physical aws-studio release.");
  }
  const appRequire = createRequire(path.join(root, "package.json"));
  const frameworkRequire = createRequire(path.join(release, "package.json"));
  for (const [specifier, from] of [
    ["aws-cdk-lib", "node_modules/aws-cdk-lib"],
    ["constructs", "node_modules/constructs"],
    [generatedPeerName + "/target-ids", generatedPeerPath],
  ]) {
    const entry = realpathSync(frameworkRequire.resolve(specifier));
    const relative = path.relative(path.join(root, from), entry);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || realpathSync(appRequire.resolve(specifier)) !== entry) {
      throw new Error(`The test application's aws-studio must share the application's ${specifier}.`);
    }
  }
}

function immutableTreeDigest(root) {
  const digest = createHash("sha256");
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix + name, file = path.join(directory, name);
      const info = lstatSync(file);
      if (name === "node_modules" && info.isDirectory()) continue;
      if (!publicStarterPath(relative) || realpathSync(file) !== file) {
        throw new Error("The shared test project contains private state or linked source. Use a scratch project for writers.");
      }
      digest.update(relative).update("\0").update(String(info.mode)).update("\0");
      if (info.isDirectory()) visit(file, relative + "/");
      else if (info.isFile() && info.nlink === 1) digest.update(hash("sha256", readFileSync(file), "hex"));
      else throw new Error("Unexpected file type in the shared test project.");
    }
  }
  visit(root);
  return digest.digest("hex");
}

/** Synthetic cases may resolve registry code from their parent, without any app workspace links. */
function linkFixtureDependencies(project, instance) {
  const modules = path.join(project, "node_modules");
  const projection = path.join(instance, "node_modules");
  mkdirSync(projection);
  const link = (source, target) => {
    if (lstatSync(source).isDirectory() && realpathSync(source) === source) {
      symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    }
  };
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const source = path.join(modules, entry.name), target = path.join(projection, entry.name);
    if (entry.name.startsWith("@")) {
      mkdirSync(target);
      for (const name of readdirSync(source)) link(path.join(source, name), path.join(target, name));
    } else link(source, target);
  }
}

export function preparedTestProject(input) {
  if (!input || !path.isAbsolute(input)) return undefined;
  const project = realpathSync(input);
  const instance = path.dirname(project), relative = path.relative(realpathSync(tmpdir()), instance);
  if (!/^aws-studio-test-projects\/[0-9a-f]{12}\/[0-9a-f]{12}-[0-9a-f]{24}\/app-[A-Za-z0-9]{6}$/.test(relative.split(path.sep).join("/")) ||
      path.basename(project) !== "project") {
    throw new Error("Test commands require the prepared disposable starter project.");
  }
  const fallback = path.join(instance, "node_modules");
  if (!lstatSync(fallback).isDirectory() || realpathSync(fallback) !== fallback) {
    throw new Error("Test dependencies need a physical projection directory.");
  }
  const manifest = json(project, "node_modules/aws-studio/package.json");
  checkRelease(project, manifest.version);
  const evidence = json(instance, "source.json");
  if (immutableTreeDigest(project) !== evidence.source ||
      immutableTreeDigest(path.join(project, "node_modules/aws-studio")) !== evidence.release) {
    throw new Error("The shared starter source or installed release changed. Use a scratch project for writers.");
  }
  return project;
}

/** Install the starter with the current platform package and an offline deployment test target. */
export async function prepareTestProject(root = platformRoot, env = process.env) {
  root = realpathSync(root);
  const selection = readStarterSelection(root, env);
  const runtime = await import(pathToFileURL(path.join(root, "packages/aws-studio/cli/project-node.mjs")).href);
  const tools = runtime.findProjectToolchain(root, env);
  const npmEnv = npmEnvironment(runtime, tools, env);
  function npm(cwd, args) {
    execFileSync(tools.node, [tools.npm, ...args], { cwd, env: npmEnv, windowsHide: true, stdio: ["ignore", "ignore", "inherit"] });
  }
  function verifyInstalledPeers(cwd) {
    const bytes = execFileSync(tools.node, [tools.npm, "query", "[name=aws-cdk-lib], [name=constructs]", "--offline"], {
      cwd, env: npmEnv, windowsHide: true, encoding: "utf8",
    });
    const found = JSON.parse(bytes);
    for (const peer of ["aws-cdk-lib", "constructs"]) {
      const packages = found.filter(entry => entry.name === peer);
      if (packages.length !== 1 || realpathSync(packages[0].realpath) !== path.join(cwd, "node_modules", peer)) {
        throw new Error(`Expected one physical installation of the test project's ${peer}.`);
      }
    }
  }
  const { version } = json(root, "packages/aws-studio/package.json");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error("Expected the exact development release version.");
  const base = path.join(realpathSync(tmpdir()), "aws-studio-test-projects");
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base) throw new Error("The test project cache must be a physical directory.");
  const pack = mkdtempSync(path.join(base, "pack-"));
  try {
    npm(root, ["run", "pack", "--", pack]);
    const name = `aws-studio-${version}.tgz`;
    const packed = readFileSync(path.join(pack, name));
    const key = createHash("sha256").update(packed).update(JSON.stringify(productionTargets)).digest("hex");
    const integrity = "sha512-" + hash("sha512", packed, "base64");
    const cache = path.join(base, hash("sha256", root, "hex").slice(0, 12), selection.commit.slice(0, 12) + "-" + key.slice(0, 24));
    mkdirSync(cache, { recursive: true });
    if (realpathSync(cache) !== cache) throw new Error("The prepared test project cache must be a physical directory.");
    const ready = path.join(cache, "ready.json");
    try {
      if (!lstatSync(ready, { throwIfNoEntry: false })?.isFile()) throw new Error("Missing cache marker.");
      const cached = json(cache, "ready.json");
      if (cached.commit === selection.commit && cached.integrity === integrity && /^app-[A-Za-z0-9]{6}$/.test(cached.directory)) {
        const reusable = path.join(cache, cached.directory, "project");
        if (preparedTestProject(reusable) === reusable && json(reusable, "node_modules/aws-studio/package.json").version === version) {
          return reusable;
        }
      }
    } catch { /* Rebuild an incomplete, removed, or changed cache. */ }

    const instance = mkdtempSync(path.join(cache, "app-"));
    const project = path.join(instance, "project");
    try {
      mkdirSync(project);
      const files = readStarterFiles(selection);
      writeStarterFiles(project, files);
      const cdk = json(project, cdkFile);
      // Deployment tests need a target, while usable starter releases leave targets unconfigured.
      cdk.context["framework:targets"] = productionTargets;
      writeJson(project, cdkFile, cdk);
      const testCdkBytes = readFileSync(path.join(project, cdkFile));
      const spec = "file:vendor/" + name;
      const manifest = json(project, "package.json");
      const starterSpec = manifest.dependencies?.["aws-studio"];
      if (!/^file:vendor\/aws-studio-\d+\.\d+\.\d+\.tgz$/.test(starterSpec ?? "") || manifest.devDependencies?.["aws-studio"] !== undefined) {
        throw new Error("The recorded starter must pin a vendored aws-studio archive once in dependencies.");
      }
      const starterArchive = path.join(project, starterSpec.slice("file:".length));
      if (!lstatSync(starterArchive).isFile()) throw new Error("The recorded starter has no vendored AWS Studio release.");
      const vendor = path.join(project, "vendor", name);
      if (starterSpec !== spec || !readFileSync(starterArchive).equals(packed)) {
        writeFileSync(vendor, packed);
        if (starterSpec !== spec) {
          manifest.dependencies["aws-studio"] = spec;
          writeJson(project, "package.json", manifest);
        }
        const previous = json(project, "package-lock.json");
        // npm otherwise keeps the previous integrity for the same file: spec.
        delete previous.packages["node_modules/aws-studio"];
        writeJson(project, "package-lock.json", previous);
        npm(project, ["install", "--package-lock-only", "--ignore-scripts", "--offline"]);
      }
      const lock = json(project, "package-lock.json");
      if (lock.lockfileVersion !== 3 || lock.packages[""].dependencies?.["aws-studio"] !== spec ||
          lock.packages["node_modules/aws-studio"]?.integrity !== integrity) {
        throw new Error("The test project's package lock does not pin the current development archive.");
      }
      // Windows npm workspace links can contain absolute junction targets.
      // Install directly in this final directory and publish its location only when installation succeeds.
      npm(project, ["ci", "--offline", "--include=dev"]);
      checkRelease(project, version);
      verifyInstalledPeers(project);
      for (const { relative, bytes } of files) {
        const expected = relative === cdkFile ? testCdkBytes : bytes;
        if (!["vendor/" + name, "package-lock.json", ...(starterSpec === spec ? [] : ["package.json"])].includes(relative) && !readFileSync(path.join(project, relative)).equals(expected)) {
          throw new Error("Installation changed a tracked file from the recorded starter.");
        }
      }
      writeJson(instance, "source.json", {
        source: immutableTreeDigest(project),
        release: immutableTreeDigest(path.join(project, "node_modules/aws-studio")),
      });
      mkdirSync(path.join(instance, "scratch/.cache/framework-studio"), { recursive: true });
      linkFixtureDependencies(project, instance);
      const marker = `ready-${path.basename(instance)}.json`;
      writeJson(cache, marker, { commit: selection.commit, integrity, directory: path.basename(instance) });
      renameSync(path.join(cache, marker), ready);
      return project;
    } catch (error) {
      rmSync(instance, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error;
    }
  } finally {
    rmSync(pack, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(await prepareTestProject()); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
