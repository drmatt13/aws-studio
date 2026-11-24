import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const platformRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
export const generatedPeerPath = "packages/framework-generated";
export const generatedPeerName = "@repo/framework-generated";
const hashPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const forbiddenDirectories = new Set(["node_modules", ".git", ".cache", ".framework", ".aws", ".ssh", ".gnupg", ".npm", "cdk.out"]);
const forbiddenFiles = new Set(["cdk.context.json", ".secret-bindings.json", ".npmrc", ".netrc", ".pypirc", "credentials", "id_rsa", "id_ed25519"]);

function git(root, args, options = {}) {
  return execFileSync("git", ["--no-replace-objects", "-c", "protocol.allow=never", "-C", root, ...args], {
    maxBuffer: 128 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, ...options,
  });
}

export function readStarterSelection(installation = platformRoot, env = process.env) {
  const settings = JSON.parse(readFileSync(path.join(installation, "scripts/starters.json"), "utf8"));
  if (!hashPattern.test(settings.commit) || !/^[a-z0-9-]+$/.test(settings.app ?? "")) {
    throw new Error("scripts/starters.json requires an exact starter commit and a single application directory.");
  }
  const checkout = env.AWS_STUDIO_STARTERS ?? path.resolve(installation, "../aws-studio-starter-projects");
  let root;
  try { root = realpathSync(checkout); }
  catch { throw new Error(`The starter checkout is missing at ${checkout}. Clone ${settings.repository} beside AWS Studio or set AWS_STUDIO_STARTERS.`); }
  let commit;
  try {
    commit = git(root, ["rev-parse", "--verify", settings.commit + "^{commit}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`Starter commit ${settings.commit} is unavailable in the local AWS_STUDIO_STARTERS repository.`);
  }
  if (commit !== settings.commit) throw new Error("The starter pin must identify the exact commit object.");
  return { root, commit, app: settings.app };
}

export function publicStarterPath(name) {
  const segments = name.split("/");
  const basename = segments.at(-1).toLowerCase();
  return segments.slice(0, -1).every(segment => !/^\.env(?:\.|$)/i.test(segment)) &&
    segments.every(segment =>
    /^[a-z0-9._+@ -]+$/i.test(segment) &&
    !/[. ]$/.test(segment) &&
    !/^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) &&
    !forbiddenDirectories.has(segment.toLowerCase())) &&
    !forbiddenFiles.has(basename) && !/\.(?:pem|key|p12|pfx)$/.test(basename) &&
    (!/^\.env(?:\.|$)/.test(basename) || /\.(?:example|template)$/.test(basename));
}

/** Read only regular, public file blobs from the recorded Git tree. */
export function readStarterFiles(selection, subtree = "") {
  const prefix = subtree ? `${selection.app}/${subtree}/` : `${selection.app}/`;
  const tree = git(selection.root, ["ls-tree", "-r", "-z", selection.commit, "--", prefix], { encoding: "utf8" });
  const seen = new Set();
  const entries = tree.split("\0").filter(Boolean).map(line => {
    const match = /^(100(?:644|755)) blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (!match || !hashPattern.test(match[2]) || !match[3].startsWith(prefix)) {
      throw new Error("The starter tree contains an unsupported Git entry.");
    }
    const relative = match[3].slice(prefix.length), key = relative.toLowerCase();
    if (!publicStarterPath(relative) || seen.has(key)) throw new Error("The starter tree contains a private, unsafe, or duplicate file path.");
    seen.add(key);
    return { oid: match[2], mode: match[1] === "100755" ? 0o755 : 0o644, relative };
  });
  if (!entries.some(entry => entry.relative === "package.json")) throw new Error("The recorded starter tree has no package.json.");
  const blobs = git(selection.root, ["cat-file", "--batch"], { input: entries.map(entry => entry.oid + "\n").join("") });
  let offset = 0;
  return entries.map(entry => {
    const newline = blobs.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("Git did not provide every recorded starter blob.");
    const [oid, type, length] = blobs.subarray(offset, newline).toString("ascii").split(" ");
    const size = Number(length), start = newline + 1, end = start + size;
    if (oid !== entry.oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || blobs[end] !== 0x0a) {
      throw new Error("Git returned an invalid starter blob.");
    }
    offset = end + 1;
    return { ...entry, bytes: blobs.subarray(start, end) };
  });
}

/** Write a verified tree into a new, isolated directory. */
export function writeStarterFiles(destination, files) {
  for (const { relative, mode, bytes } of files) {
    const target = path.join(destination, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode, flag: "wx" });
  }
}
