/** Disposable-process fixture, never imported by the production host. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [root, state, control] = process.argv.slice(2);
if (!root || !state || !control) throw new Error("Fixture paths are required.");
async function main() {
  const { startAgentHost } = await import("../../server/agent-runtime/host");
  const { integrateAgentProposal } = await import("../../server/agent-runtime/integration");
  process.send?.({ phase: "modules-loaded" });
  const host = await startAgentHost(root!, state!, {
    copyDependencies: false,
    contractOrigin: async () => {},
    runProvider: async options => {
      await options.onEvent({ type: "session", data: { sessionId: "fixture-native-session" } });
      await options.onEvent({ type: "command", data: { phase: "started", command: "disposable fixture check" } });
      while (!existsSync(control) && !options.signal.aborted) await new Promise(resolve => setTimeout(resolve, 20));
      if (options.signal.aborted) return { status: "cancelled" };
      writeFileSync(path.join(options.cwd, "application.ts"), "export const message = 'reviewed change';\n");
      await options.onEvent({ type: "file", data: { path: "application.ts", phase: "completed" } });
      await options.onEvent({ type: "command", data: { phase: "completed", command: "disposable fixture check", exitCode: 0 } });
      return { status: "completed", sessionId: "fixture-native-session" };
    },
    validate: async options => ({ exitCode: readFileSync(path.join(options.cwd, "application.ts"), "utf8").includes("reviewed change") ? 0 : 1 }),
    integrate: async (_workspace, proposal, digest) => integrateAgentProposal(proposal, digest),
  });
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
  process.send?.({ phase: "ready" });
  process.channel?.unref();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void host.close().then(() => process.exit(0)); });
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect?.(); });
