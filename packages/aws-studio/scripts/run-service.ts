import { isTargetEnabled } from "../src/config/index";
import { spawn } from "node:child_process";
import { frameworkRepositoryRoot, localDeployInputs, resolveServicePort } from "../src/config/source";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { loadFrameworkConfig } from "../src/config/source";
import { initializeDevelopmentLogProducer } from "../src/local/development-logs/producer";
import { DevelopmentTextFramer, developmentSecrets, observeDevelopment } from "../src/development-logs/index";

// The project this runs for, loaded by root: see loadFrameworkConfig.
const framework = loadFrameworkConfig();

async function main(): Promise<void> {
  const [id, separator, command, ...args] = process.argv.slice(2);
  if (!id || separator !== "--" || !command) throw new Error("Usage: run-service <service-id> -- <command> [...args]");
  const repositoryRoot = frameworkRepositoryRoot();
  if (!isTargetEnabled(framework, "service", id, "local", localDeployInputs(repositoryRoot))) {
    console.log(`Service ${id} does not run locally: its deployment setting or condition is disabled.`);
    return;
  }
  const env = await resolveLocalWorkloadEnvironment(framework, `service:${id}`, { repositoryRoot });
  // Ports belong to the container and the declaration, not to resource inputs:
  // the container's PORT when it sets one (framework:generate checks that it
  // agrees), otherwise the declared port, which is the one ECS is given.
  env.PORT = process.env.PORT || String(resolveServicePort(framework, id, { repositoryRoot }));
  const producer = initializeDevelopmentLogProducer({ component: "service-launcher", repositoryRoot, resourceId: `service:${id}` });
  const child = spawn(command, args, { env, stdio: ["inherit", "pipe", "pipe"] });
  observeDevelopment({ resourceId: `service:${id}`, kind: "service.started" });
  // Compose retains this sanitized output while the collector is unavailable.
  // Its verified service follower is the one owner of cached process output.
  const tee = (input: typeof child.stdout, output: NodeJS.WritableStream) => {
    let blocked = false;
    return new DevelopmentTextFramer(message => {
      if (!output.write(message) && !blocked) {
        blocked = true; input.pause();
        output.once("drain", () => { blocked = false; input.resume(); });
      }
    }, developmentSecrets(`service:${id}`));
  };
  const stdout = tee(child.stdout, process.stdout);
  const stderr = tee(child.stderr, process.stderr);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
  child.once("error", error => { observeDevelopment({ resourceId: `service:${id}`, kind: "service.failed", level: "error", details: { error } }); console.error(`Unable to start service ${id}.`); process.exitCode = 1; });
  child.once("close", (code, signal) => {
    stdout.flush(); stderr.flush();
    observeDevelopment({ resourceId: `service:${id}`, kind: "service.exited", level: code === 0 ? "info" : "error", details: { code, signal } });
    process.exitCode = code === null || code < 0 ? 1 : code;
    void producer.close();
  });
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Service startup failed."); process.exitCode = 1; });
