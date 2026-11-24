import { spawn } from "node:child_process";

// Docker Desktop is an independent application. Its launcher can report a
// failure while the engine is still coming up (notably during WSL startup).
// The following operation step decides success from the engine itself.
const executable = process.env.FRAMEWORK_DOCKER_CLI ? process.execPath : "docker";
const prefix = process.env.FRAMEWORK_DOCKER_CLI ? [process.env.FRAMEWORK_DOCKER_CLI] : [];
const child = spawn(executable, [...prefix, "desktop", "start", "--timeout", "120"], {
  stdio: "inherit", windowsHide: true, shell: false,
});
let failedToLaunch = false;
child.on("error", error => {
  failedToLaunch = true;
  console.error(`Unable to launch Docker Desktop: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (failedToLaunch) return;
  if (signal || code === null) { process.exitCode = 1; return; }
  if (code !== 0) console.log(`Docker Desktop's launcher exited with status ${code}. Checking whether the engine finishes starting.`);
});
