import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const observedBytes = new Map();
const stamp = info => [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");

export function protectedTree(root) {
  const hashes = { source: createHash("sha256"), dependencies: createHash("sha256") };
  function visit(dir, prefix = "", key = "source") {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix + name;
      if (relative === ".git" || relative === ".cache/framework-studio") continue;
      const location = path.join(dir, name);
      const info = lstatSync(location, { bigint: true });
      if (info.isDirectory()) {
        visit(location, relative + "/", name === "node_modules" ? "dependencies" : key);
        continue;
      }
      hashes[key].update(relative + "\0" + (info.mode & 0o777n) + "\0");
      if (info.isSymbolicLink()) hashes[key].update(readlinkSync(location));
      else {
        const before = stamp(info);
        const known = observedBytes.get(location);
        const digest = known?.stamp === before ? known.digest : hash(location);
        assert.equal(stamp(lstatSync(location, { bigint: true })), before, `${relative} changed during inventory`);
        observedBytes.set(location, { stamp: before, digest });
        hashes[key].update(digest);
      }
      hashes[key].update("\0");
    }
  }
  visit(root);
  return Object.fromEntries(Object.entries(hashes).map(([key, h]) => [key, h.digest("hex")]));
}
