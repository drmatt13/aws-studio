import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { distributionJson as json, distributionQualification, qualificationCache, readDistributionArchive } from "./distribution-qualification.mjs";
import { hash, protectedTree } from "./qualification-evidence.mjs";

const [archiveInput, studioInput, projectInput, evidenceInput, ...extra] = process.argv.slice(2);
if (!evidenceInput || extra.length || !process.env.npm_config_cache) {
  throw new Error("Set npm_config_cache to a populated writable cache and pass <Studio archive> <Studio Node executable> <project Node executable> <new evidence directory>.");
}
const archive = readDistributionArchive(archiveInput);
const studioNode = realpathSync(studioInput), projectNode = realpathSync(projectInput);
const cache = qualificationCache(process.env.npm_config_cache);
assert.notEqual(studioNode, projectNode, "Choose independently installed Studio and project runtimes.");

mkdirSync(path.resolve(evidenceInput));
const evidence = realpathSync(evidenceInput);
const { install, record, run, toolchain } = distributionQualification(evidence, cache);
const { release, bundledFramework, studioRuntime, studioEnv, launcher, starterPin } =
  install(archive, studioNode, projectNode, { readStarterPin: true });

const project = path.join(evidence, "App é");
run("create and open an independent app offline", studioRuntime.node,
  [launcher, "--create-project", project, "--name", "qualification-app", "--print"], evidence, studioEnv);
const projectRuntime = toolchain("app", project, projectNode);
assert.notEqual(projectRuntime.npm, studioRuntime.npm);
const projectManifest = json(project, "package.json");
const projectFramework = path.join(project, "node_modules", "aws-studio");
assert.equal(realpathSync(projectFramework), projectFramework, "The app must install its own physical framework.");
const appRelease = json(projectFramework, "package.json").version;
const appPin = json(project, "package-lock.json").packages["node_modules/aws-studio"];
for (const key of ["version", "resolved", "integrity"]) {
  assert.equal(appPin[key], starterPin[key], `Create must preserve the embedded starter framework ${key}.`);
}
assert.equal(appPin.version, appRelease);
assert.equal(appPin.resolved, projectManifest.dependencies["aws-studio"]);
record("independent runtime and artifact identities", {
  studio: release.version, studioRuntime, bundledFramework: release.frameworkVersion, frameworkSha256: hash(bundledFramework),
  appRelease, appRuntime: projectRuntime, appArchive: appPin.resolved, appArchiveIntegrity: appPin.integrity,
});

const git = (name, args) => run(name, "git", args, project);
assert.equal(realpathSync(git("locate the app's repository", ["rev-parse", "--show-toplevel"])), project);
appendFileSync(path.join(project, "framework.config.ts"),
  `\nif (process.versions.node !== ${JSON.stringify(projectRuntime.version)}) throw new Error("Wrong runtime for app evaluation");\n`);
git("stage the public smoke fixture", ["add", "--all"]);
git("save the independent repository revision", ["-c", "user.name=AWS Studio qualification",
  "-c", "user.email=qualification@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Record distribution smoke app"]);
const revision = git("record the app revision", ["rev-parse", "HEAD"]);
const before = protectedTree(project);
const snapshot = JSON.parse(run("reopen and evaluate the app", studioRuntime.node,
  [launcher, "--project", project, "--print"], evidence, studioEnv));
assert.equal(snapshot.repositoryRoot, project);
for (const mode of ["dev", "prod"]) assert.equal(snapshot.models[mode].status, "ok", JSON.stringify(snapshot.models[mode].diagnostics));
const after = protectedTree(project);
assert.deepEqual(after, before);
assert.equal(git("verify source remains clean", ["status", "--porcelain", "--untracked-files=all"]), "");
assert.equal(git("verify the app revision", ["rev-parse", "HEAD"]), revision);
record("installed distribution smoke passed", { revision, before, after, permittedState: ".cache/framework-studio", modes: ["dev", "prod"] });
