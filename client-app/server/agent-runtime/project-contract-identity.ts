import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProofPolicy } from "aws-studio/contract-chain/contract-proof";
import { portableProofPolicy, type PortableProofIdentity } from "aws-studio/contract-chain/portable-identity";
import { resolveProjectInstallation } from "../project-release";
import { projectRuntime, projectRuntimeEnvironment } from "../project-runtime";

type WorkerAsset = { readonly file: string; readonly digest: string };
const MAX_IPC_BYTES = 8 * 1024 * 1024;
let workerBundle: Promise<Buffer> | undefined;

/** Compile trusted verifier code without a project loader or runtime dependencies. */
export function buildProjectIdentityWorker(): Promise<Buffer> {
  return workerBundle ??= (async () => {
    const { build } = await import("esbuild");
    const entry = createRequire(__filename).resolve("aws-studio/contract-chain/portable-identity");
    const source = `const { portableProofIdentity } = require(${JSON.stringify(entry)});
const [id, digest] = process.argv.slice(2);
process.once('disconnect', () => process.exit());
portableProofIdentity(process.cwd(), { policy: { id, digest } }).then(identity => {
  if (Buffer.byteLength(JSON.stringify(identity)) > ${MAX_IPC_BYTES}) throw new Error('Contract identity exceeds the size limit');
  process.send(identity, () => process.disconnect());
}).catch(() => { process.exitCode = 1; process.disconnect(); });`;
    const result = await build({ stdin: { contents: source, resolveDir: path.dirname(entry) }, bundle: true,
      platform: "node", format: "cjs", target: "node24", write: false, logLevel: "silent" });
    if (result.outputFiles.length !== 1) throw new Error("Could not pin the portable proof identity worker.");
    return Buffer.from(result.outputFiles[0]!.contents);
  })();
}

/** Source and dependency hashing needs to see all public source names. The
 * metadata-only child reads project bytes, and neither loads its modules nor
 * has filesystem writes or subprocess permissions. Executable app validation
 * uses the separate native sandbox. */
export async function readProjectContractIdentity(root: string, policy: ProofPolicy, signal: AbortSignal, asset?: WorkerAsset): Promise<PortableProofIdentity> {
  signal.throwIfAborted();
  const project = resolveProjectInstallation(root);
  const assertPolicy = () => {
    const current = portableProofPolicy(project.framework);
    if (current.id !== policy.id || current.digest !== policy.digest) {
      throw new Error("The project checker policy differs from the pinned agent host. Preserve the candidate and restart the agent host before renewing proof.");
    }
  };
  assertPolicy();
  const runtime = projectRuntime(project.root);
  const bytes = asset ? await readFile(asset.file) : await buildProjectIdentityWorker();
  if (asset && createHash("sha256").update(bytes).digest("hex") !== asset.digest) throw new Error("Pinned contract identity worker bytes changed.");
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), "studio-contract-identity-")));
  try {
    const file = path.join(directory, "contract-identity.cjs");
    await writeFile(file, bytes, { flag: "wx", mode: 0o400 });
    signal.throwIfAborted();
    const identity = await new Promise<PortableProofIdentity>((resolve, reject) => {
      const child = fork(file, [policy.id, policy.digest], {
        cwd: project.root, execPath: runtime.node,
        execArgv: ["--permission", `--allow-fs-read=${project.root}`, `--allow-fs-read=${directory}`],
        env: projectRuntimeEnvironment(runtime), stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let reply: PortableProofIdentity | undefined, spawnError: Error | undefined;
      const stop = () => { child.kill("SIGKILL"); };
      const timeout = setTimeout(stop, 300_000);
      signal.addEventListener("abort", stop, { once: true });
      child.once("message", value => { reply = value as PortableProofIdentity; });
      child.once("error", error => { spawnError = error; });
      child.once("close", code => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", stop);
        if (signal.aborted) reject(signal.reason);
        else if (spawnError) reject(spawnError);
        else if (code !== 0 || !reply) reject(new Error("The read-only project identity worker did not complete. Check the project's installed verifier and runtime."));
        else resolve(reply);
      });
      if (signal.aborted) stop();
    });
    if (identity?.version !== 1 || identity.policy?.id !== policy.id || identity.policy?.digest !== policy.digest || identity.toolchain?.node !== runtime.version ||
        !/^[a-f0-9]{64}$/.test(identity.sourceRevision) || !/^[a-f0-9]{64}$/.test(identity.toolchain.dependencyDigest)) {
      throw new Error("The read-only project identity worker returned an unexpected policy or runtime.");
    }
    assertPolicy();
    return identity;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
