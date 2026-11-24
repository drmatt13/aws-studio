import assert from "./support/assert";
import { test } from "node:test";
import path from "node:path";
import { JsonLinesProcess } from "../server/agent-runtime/providers/transport";

const root = path.resolve(__dirname, "../..");
const burst = "process.stdout.write(Array.from({length:1024},(_,index)=>JSON.stringify({index})+'\\n').join(''))";

test("a provider burst gives queued host I/O a turn before draining every durable event", { timeout: 15_000 }, async () => {
  let received = 0, observed = 0;
  const child = new JsonLinesProcess(process.execPath, ["-e", burst], root, process.env, async value => {
    assert.equal(value.index, received++);
    if (received === 1) setImmediate(() => { observed = received; });
  }, async () => {});
  try {
    assert.equal(await child.closed, 0);
    assert.equal(child.error(), undefined);
    assert.equal(received, 1024, "all evidence remains ordered and lossless");
    assert.ok(observed > 0 && observed <= 32, `queued I/O first ran after ${observed} durable callbacks`);
  } finally { child.stop(); await child.closed; }
});

test("an I/O cancellation during a provider burst stops queued consumers and drains the owned child", { timeout: 15_000 }, async () => {
  let received = 0;
  const reason = new Error("cancel queued provider burst");
  const child = new JsonLinesProcess(process.execPath, ["-e", burst + ";process.stdin.resume()"], root, process.env, async () => {
    if (++received === 1) setImmediate(() => child.fail(reason));
  }, async () => {});
  try {
    await child.closed;
    assert.equal(child.error(), reason);
    assert.ok(received > 0 && received <= 32, `cancellation arrived after ${received} durable callbacks`);
  } finally { child.stop(); await child.closed; }
});
