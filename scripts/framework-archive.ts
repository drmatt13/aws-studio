import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** The manifest of an npm pack archive, whose entries are under package/. */
function archiveManifest(bytes: Buffer): unknown {
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/");
    const size = Number.parseInt(field(124, 12).trim(), 8);
    offset += 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) break;
    if (name === "package/package.json" && ["", "0"].includes(field(156, 1))) {
      return JSON.parse(tar.subarray(offset, offset + size).toString("utf8"));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error("The archive has no package/package.json.");
}

export function readFrameworkArchive(file: string) {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) throw new Error(`The framework archive is missing at ${file}.`);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error(`The framework archive at ${file} must be a regular file.`);
  const bytes = readFileSync(file);
  let manifest: { readonly name?: unknown; readonly version?: unknown; readonly studioCompatibility?: unknown; readonly engines?: { readonly node?: unknown; readonly npm?: unknown } } | undefined;
  try { manifest = archiveManifest(bytes) as typeof manifest; }
  catch { throw new Error(`The framework archive at ${file} is not a readable npm package.`); }
  return { bytes, manifest, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}
