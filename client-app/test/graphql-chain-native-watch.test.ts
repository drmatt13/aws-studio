import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { watchContractSources } from "../server/graphql-chain/source-watcher";

test("native contract watcher observes nested edits and atomic saves without read notifications", { timeout: 45_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chain-native-watch-"));
  mkdirSync(path.join(root, "nested"));
  const edited = "nested/contract.prisma";
  const replaced = "nested/atomic.prisma";
  for (const name of [edited, replaced]) writeFileSync(path.join(root, name), "// before");
  const marker = "watch-ready";
  const events: (string | undefined)[] = [];
  let ready = false, failed = false;
  const watcher = await watchContractSources(root, name => {
    const normalized = name?.replaceAll("\\", "/");
    if (normalized === marker) ready = true;
    else events.push(normalized);
  }, () => { failed = true; });
  const until = async (label: string, observed: () => boolean, stimulate?: () => void) => {
    const began = Date.now();
    while (!observed() && !failed && Date.now() - began < 5000) {
      stimulate?.();
      await delay(25);
    }
    assert.equal(failed, false, `native watcher failed during ${label}`);
    assert.ok(observed(), `expected native notification for ${label}`);
  };
  try {
    // macOS starts the event stream asynchronously and can deliver queued setup events.
    let attempts = 0;
    await until("watch startup", () => ready, () => writeFileSync(path.join(root, marker), String(++attempts)));
    await delay(300);
    events.length = 0;
    for (let i = 0; i < 100; i++) readFileSync(path.join(root, edited));
    await delay(300);
    assert.equal(events.length, 0);
    writeFileSync(path.join(root, edited), "// after!");
    await until("nested edit", () => events.includes(edited));
    const replacement = path.join(root, "replacement");
    writeFileSync(replacement, "// atomic");
    renameSync(replacement, path.join(root, replaced));
    await until("atomic save", () => events.includes(replaced));
  } finally { watcher.close(); rmSync(root, { recursive: true, force: true }); }
});
