import type { ChildProcess } from "node:child_process";

// Source-mode imports capture the installed dependency identity before serving
// requests. On the supported Windows host this takes 35–37 seconds; it is not
// server startup or shutdown. Give this separate, observable phase a bounded
// budget, leaving each lifecycle assertion's original deadline intact.
export function awaitFixturePhase(child: ChildProcess, phase: string, output: () => string, timeout = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let released = false;
    const closed = new Promise<void>(done => child.once("close", () => { released = true; done(); }));
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("error", failed); child.off("exit", exited); };
    const failed = (error: Error) => {
      cleanup();
      if (!released && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // exit records process death; close also releases its stdio/IPC handles.
      void closed.then(() => reject(error));
    };
    const exited = (code: number | null) => failed(new Error(`Fixture exited ${code} before ${phase}: ${output()}`));
    const message = (value: unknown) => {
      if (value && typeof value === "object" && "phase" in value && value.phase === phase) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => {
      const error = new Error(`Fixture did not reach ${phase} within ${timeout}ms: ${output()}`);
      failed(error);
    }, timeout);
    child.on("message", message); child.once("error", failed); child.once("exit", exited);
  });
}
