import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fixedContractBytes, portableFileDigest, portableProofPolicy } from "aws-studio/contract-chain/portable-identity";

/**
 * What Studio runs around the framework's contract verifier when it proposes or reviews proof:
 * the Coding contract stages, the agent host and its pinned release, the native sandbox runner,
 * and Studio's inspection, review and acceptance flow.
 *
 * None of this decides a verdict. `npm run contract:check` recomputes every receipt with the
 * framework verifier alone and accepts a recorded receipt only when its fresh recomputation is
 * identical, so these files are not part of the proof policy receipts bind. They are still
 * Studio's trusted control code: a Studio process (or a pinned agent host) must not keep
 * authorizing contract work after that code changed beneath it. Studio therefore checks this
 * identity — the framework's proof policy plus these files — before contract work, pins it into
 * every agent-host release, and admits a pinned host for contract runs only while it matches.
 */
export const STUDIO_CONTRACT_CONTROL_ID = "studio-contract-control/v1";
export const STUDIO_CONTRACT_CONTROL_FILES = [
  "client-app/server/graphql-chain/cli.ts",
  "client-app/server/graphql-chain/service.ts",
  "client-app/server/graphql-chain/sandbox.ts",
  "client-app/server/graphql-chain/inspection-host.ts",
  "client-app/server/graphql-chain/watch-inputs.ts",
  "client-app/server/graphql-chain/source-watcher.ts",
  "client-app/server/graphql-chain/evidence-cache.ts",
  "client-app/server/graphql-chain/review.ts",
  "client-app/server/agent-runtime/contract-control.ts",
  "client-app/server/project-cli.ts",
  "client-app/server/agent-runtime/contract-validation.ts",
  "client-app/server/agent-runtime/project-contract-identity.ts",
  "client-app/server/agent-runtime/contract-finalization.ts",
  "client-app/server/agent-runtime/service.ts",
  "client-app/server/agent-runtime/host.ts",
  "client-app/server/agent-runtime/client.ts",
  "client-app/server/agent-runtime/runtime-release.ts",
  "client-app/server/agent-runtime/runtime-release-manifest.ts",
  "client-app/server/agent-runtime/policy.ts",
  "client-app/server/agent-runtime/providers/validation.ts",
  "client-app/server/agent-runtime/providers/toolchain.ts",
  "client-app/server/agent-runtime/providers/codex.ts",
  "client-app/server/agent-runtime/providers/transport.ts",
  "client-app/server/agent-runtime/providers/boundary.ts",
  "client-app/server/evaluator/restricted.ts",
  "client-app/server/deploy/process.ts",
  "client-app/server/files.ts",
  "client-app/server/database.ts",
  "client-app/shared/agent-runtime.ts",
  "client-app/shared/contract-propagation.ts",
] as const;

const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Studio's contract control identity for the checkout at root. Throws when any input is missing or linked. */
export function studioContractControl(rootInput: string, verifierRoot?: string): string {
  const root = realpathSync(rootInput);
  const files = [...STUDIO_CONTRACT_CONTROL_FILES].sort().map(name => [name, portableFileDigest(name, fixedContractBytes(root, name)!)]);
  return fingerprint({ id: STUDIO_CONTRACT_CONTROL_ID, policy: portableProofPolicy(verifierRoot).digest, files });
}
