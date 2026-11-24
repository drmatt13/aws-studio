import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const installation = new URL("../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", installation), "utf8"));
const release = JSON.parse(readFileSync(new URL("scripts/studio-release.json", installation), "utf8"));
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const compatibleNode = (minimum, current) => {
  if (!exactVersion.test(minimum)) return false;
  const [major, minor, patch] = current.split(".").map(Number);
  const [requiredMajor, requiredMinor, requiredPatch] = minimum.split(".").map(Number);
  return major === requiredMajor && (minor > requiredMinor || minor === requiredMinor && patch >= requiredPatch);
};

if (!compatibleNode(release.runtime?.node, process.versions.node)) {
  process.stderr.write(`AWS Studio ${version} requires Node ${release.runtime.node} or later on its Node ${release.runtime.node.split(".")[0]}.x line. This executable is Node ${process.versions.node}.\n`);
  process.exitCode = 1;
} else if (process.argv[2] === "--version" && process.argv.length === 3) {
  console.log(`AWS Studio ${version} · framework ${release.frameworkVersion} · Node ${process.versions.node}`);
} else {
  const require = createRequire(import.meta.url);
  try {
    const loader = pathToFileURL(require.resolve("tsx")).href;
    const entry = fileURLToPath(new URL("client-app/server/index.ts", installation));
    const child = spawn(process.execPath, ["--import", loader, entry, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
    const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", error => { process.stderr.write(`${error.message}\n`); });
    child.once("close", (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
    });
  } catch (error) {
    process.stderr.write(`Install AWS Studio's locked dependencies with npm ci before launching. ${error.message}\n`);
    process.exitCode = 1;
  }
}
