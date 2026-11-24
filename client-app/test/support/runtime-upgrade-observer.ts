import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { OperationsClient } from "../../server/operations/client";
import { OperationsError } from "../../server/operations/ipc";

async function run() {
  const [root, state, ready, go] = process.argv.slice(2) as [string, string, string, string];
  const client = new OperationsClient(root, state);
  writeFileSync(ready, "ready\n");
  try {
    while (!existsSync(go)) await delay(10);
    try {
      await client.localStatus();
      process.stdout.write(JSON.stringify({ info: await client.ping() }));
    } catch (error) {
      if (process.platform !== "win32" || !(error instanceof OperationsError) || error.status !== 409 || !/cannot be refreshed gracefully on Windows/.test(error.message)) throw error;
      process.stdout.write(JSON.stringify({ info: await client.ping(), refusal: { status: error.status, message: error.message } }));
    }
  } finally { client.close(); }
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
