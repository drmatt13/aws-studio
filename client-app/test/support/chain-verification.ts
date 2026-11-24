import type { ChainVerification, ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import type { ReviewDecisions } from "aws-studio/contract-chain/contract-proof";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readSourceManifest } from "aws-studio/source/workspace";
import { proofDigest } from "aws-studio/contract-chain/proof-core";
import { contractFileGroup, contractSourceFileDigest, type PortableFileGroup, type PortableProofIdentity } from "aws-studio/contract-chain/portable-identity";
import { runtimeContractHash } from "aws-studio/contract-chain/evaluation";

/** Explicit successful fixture results; production never defaults missing checks to success. */
export function passedChainVerification(): ChainVerification {
  return { database: { status: "passed" }, api: { status: "passed" }, client: { status: "passed" }, consumers: { status: "passed" }, integration: { status: "passed" } };
}

/** Disposable inspection fixtures still provide explicit emitted artifact identities. */
export function putRuntimeArtifacts(root: string): void {
  const directory = path.join(root, "packages/database/src/generated");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "contract.json"), '{"fixture":true}\n');
  writeFileSync(path.join(directory, "contract.d.ts"), "export interface Contract {}\n");
}

export function verifiedEvaluation(sdl: string): ChainEvaluation {
  return { sdl, generatedSdl: sdl, schemaDiagnostics: [], generatedDiagnostics: [], documents: [], documentDiagnostics: [], documentSet: "matches", codegen: { status: "current", files: [], diagnostics: [] },
    verification: passedChainVerification(), contract: { storageHash: "a".repeat(64), executionHash: "b".repeat(64) } };
}

/** Explicit unit-fixture metadata, supplied only through the inspector constructor seam. */
export async function fixtureProofIdentity(root: string): Promise<PortableProofIdentity> {
  const source = Object.fromEntries(Object.entries(readSourceManifest(root).files).filter(([file]) => file !== "graphql-chain.review.json").map(([file, value]) => [file, value.hash]));
  // Some focused task fixtures provide only the stage under test.
  const group = (stage: PortableFileGroup) => Object.fromEntries(Object.keys(source).filter(file => (file === "codegen.ts" ? "codegen" : contractFileGroup(file)) === stage)
    .map(file => [file, contractSourceFileDigest(file, readFileSync(path.join(root, file)))]));
  const files = { database: group("database"), api: group("api"), codegen: group("codegen"), client: group("client"), generated: group("generated") };
  const { database, api, codegen, client, generated } = files;
  return { version: 1, sourceRevision: proofDigest(source), policy: { id: "unit-fixture/offline-v1", digest: "f".repeat(64) }, toolchain: { node: process.versions.node, packages: { fixture: "1" }, lockfileDigest: proofDigest(null), dependencyDigest: proofDigest(null) },
    inputs: { database: proofDigest(database), api: proofDigest(api), codegen: proofDigest(codegen), client: proofDigest(client) }, outputs: { database: (() => { try { return runtimeContractHash(root); } catch { return proofDigest(null); } })(), generated: proofDigest(generated) }, files };
}
export const fixtureReviewDecisions = {
  api: { statement: "Preserve the explicitly tested public fields, validation and owner-scoped repository behavior.", evidence: "Fixture source, executable-schema tests and repository assertions were reviewed." },
  client: { statement: "Preserve the reviewed document selections, query keys and mutation cache behavior.", evidence: "Fixture authored operations, consumers, operation/cache and transport tests were reviewed." },
};
export function fixtureDecisionsFor(scope: ReviewScope): ReviewDecisions | undefined {
  return scope.kind === "model" ? undefined : scope.kind === "baseline" ? fixtureReviewDecisions : { [scope.kind]: fixtureReviewDecisions[scope.kind] };
}
