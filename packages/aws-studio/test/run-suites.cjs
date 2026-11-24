const { spawnSync } = require("node:child_process");

// Keep each suite independently runnable and report all results on Windows too.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run the release suites with npm test.");
for (const suite of ["framework", "cdk", "local-api", "local-invocation", "local-websocket"]) {
  const result = spawnSync(process.execPath, [npm, "run", `test:${suite}`], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
