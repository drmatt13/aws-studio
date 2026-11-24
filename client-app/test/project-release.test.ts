import assert from "./support/assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import frameworkManifest from "../../packages/aws-studio/package.json";
import { assertSupportedProjectRelease, bundledFrameworkVersion, describeStudioRelease, projectProtocol, studioInstallation, studioRelease, studioReleaseArchive } from "../server/project-release";

const frameworkCompatibility = { minimumStudio: studioRelease, protocol: projectProtocol, capabilities: ["test-capability"] };
const bundledManifest = { name: "aws-studio", version: bundledFrameworkVersion, studioCompatibility: frameworkCompatibility };

/** The shape npm pack writes: a gzipped ustar archive whose manifest is package/package.json. */
function tarball(manifest: object): Buffer {
  const body = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(512);
  header.write("package/package.json", 0);
  header.write("0000644\0", 100);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\u000000", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]));
}

function fixture<T>(use: (root: string) => T): T {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-release-")));
  try { return use(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function installation(root: string, contents?: Buffer): string {
  const directory = path.join(root, "studio");
  mkdirSync(path.join(directory, "release"), { recursive: true });
  if (contents) writeFileSync(path.join(directory, "release", `aws-studio-${bundledFrameworkVersion}.tgz`), contents);
  return directory;
}

test("Studio's installation is the directory that carries its release metadata", () => {
  assert.equal(studioInstallation, path.resolve(__dirname, "../.."));
  assert.ok(existsSync(path.join(studioInstallation, "scripts/studio-release.json")));
});

test("the bundled framework admits the Studio source release", () => {
  assert.equal(frameworkManifest.version, bundledFrameworkVersion);
  const pin = { version: frameworkManifest.version, spec: frameworkManifest.version };
  assert.deepEqual(assertSupportedProjectRelease(pin, frameworkManifest.studioCompatibility, studioRelease), frameworkManifest.studioCompatibility);
});

test("Studio finds the framework archive bundled in its own installation", () => fixture((root) => {
  const bytes = tarball(bundledManifest);
  const studio = installation(root, bytes);
  assert.deepEqual(studioReleaseArchive(studio), {
    file: path.join(studio, "release", `aws-studio-${bundledFrameworkVersion}.tgz`),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    version: bundledFrameworkVersion,
    compatibility: frameworkCompatibility,
  });
}));

test("a missing or mismatched installation archive is refused by name", () => fixture((root) => {
  const studio = installation(root);
  const archive = path.join(studio, "release", `aws-studio-${bundledFrameworkVersion}.tgz`);
  assert.throws(() => studioReleaseArchive(studio), /framework archive is missing/);
  writeFileSync(archive, tarball({ name: "aws-studio", version: "0.0.0" }));
  assert.throws(() => studioReleaseArchive(studio), /contains aws-studio 0\.0\.0/);
  writeFileSync(archive, tarball({ ...bundledManifest, name: "other" }));
  assert.throws(() => studioReleaseArchive(studio), /contains other/);
  writeFileSync(archive, "not an archive");
  assert.throws(() => studioReleaseArchive(studio), /is not a readable npm package/);
  rmSync(archive);
  mkdirSync(archive);
  assert.throws(() => studioReleaseArchive(studio), /must be a regular file/);
}));

test("startup reports the installation archive and ignores the retired archive variable", () => fixture((root) => {
  const studio = installation(root, tarball(bundledManifest));
  const decoy = path.join(root, "decoy.tgz");
  writeFileSync(decoy, tarball(bundledManifest));
  const previous = process.env.AWS_STUDIO_RELEASE_ARCHIVE;
  process.env.AWS_STUDIO_RELEASE_ARCHIVE = decoy;
  try {
    assert.equal(describeStudioRelease(studio), `AWS Studio ${studioRelease} · framework ${bundledFrameworkVersion}: ${path.join(studio, "release", `aws-studio-${bundledFrameworkVersion}.tgz`)}`);
    rmSync(path.join(studio, "release"), { recursive: true });
    assert.match(describeStudioRelease(studio), /framework archive is missing.*Projects still open/);
  } finally {
    if (previous === undefined) delete process.env.AWS_STUDIO_RELEASE_ARCHIVE;
    else process.env.AWS_STUDIO_RELEASE_ARCHIVE = previous;
  }
}));

test("admission uses the declared Studio minimum and protocol independently of framework numbering", () => {
  const pin = { version: "7.0.0", spec: "7.0.0" };
  const contract = { minimumStudio: "2.2.0", protocol: 1, capabilities: ["new-capability"] };
  assert.deepEqual(assertSupportedProjectRelease(pin, contract, "2.2.0"), contract);
  assert.throws(() => assertSupportedProjectRelease(pin, contract, "2.1.0"), /requires AWS Studio version 2\.2\.0 or higher/);
  assert.throws(() => assertSupportedProjectRelease(pin, { ...contract, protocol: 2 }, "3.0.0"), /project protocol 2/);
  assert.throws(() => assertSupportedProjectRelease(pin, undefined, "3.0.0"), /no compatibility information/);
  assert.throws(() => assertSupportedProjectRelease(pin, { ...contract, capabilities: ["ambiguous", "ambiguous"] }, "3.0.0"), /invalid AWS Studio compatibility/);
  assert.equal(assertSupportedProjectRelease({ version: "2.0.0", spec: "2.0.0" }, undefined, "2.2.0").minimumStudio, "2.0.0");
});
