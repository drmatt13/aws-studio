import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { changedAgentSourceFiles, readSourceManifest } from "aws-studio/source/workspace";
import { EditError, writeSourceChange } from "aws-studio/source/io";
import { SourceJournal } from "../edits/journal";
import { readEvaluationArtifact } from "aws-studio/source/result-artifact";
import { assertCapturedAuthoredDocuments } from "aws-studio/contract-chain/authored-documents";
import { assertCodegenWritePath, CODEGEN_ARTIFACT_MARKER, GRAPHQL_GENERATED_FILES } from "./codegen-files";
import { currentReviewRecord, parseReviewRecord, REVIEW_RECORD_FILE, serializeReviewRecord } from "aws-studio/contract-chain/core";
import { runtimeContractHash } from "aws-studio/contract-chain/evaluation";
import { withLedgerEntries } from "aws-studio/contract-chain/ledger";
import { contractFileGroup, fixedContractBytes, portableFileDigest } from "aws-studio/contract-chain/portable-identity";
import { sourceFingerprints, sourceFingerprintsFromFiles } from "aws-studio/contract-chain/source-fingerprints";

type Change = { relative: string; before: string | null; after: string };

function readCodegenOutputs(file: string, output: string): Map<string, string> {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(CODEGEN_ARTIFACT_MARKER));
  if (lines.length !== 1 || lines[0]!.length > 512) throw new Error("Codegen returned no complete output receipt.");
  const payload: unknown = JSON.parse(readEvaluationArtifact(file, JSON.parse(lines[0]!.slice(CODEGEN_ARTIFACT_MARKER.length))));
  if (!Array.isArray(payload) || payload.length !== GRAPHQL_GENERATED_FILES.length) throw new Error("Codegen must produce all fixed GraphQL files.");
  const result = new Map<string, string>();
  for (const item of payload) {
    if (!item || !GRAPHQL_GENERATED_FILES.includes(item.filename) || result.has(item.filename) || typeof item.content !== "string" || !item.content.length || item.content.includes("\0")) throw new Error("Codegen returned an invalid generated file.");
    result.set(item.filename, item.content);
  }
  return result;
}

/** The command holds the checkout source-write gate throughout staging and publication. */
export function prepareCodegenRegeneration(root: string) {
  const baseline = readSourceManifest(root), database = runtimeContractHash(root);
  assertCapturedAuthoredDocuments(root, baseline.files);
  const journal = new SourceJournal(root);
  if (journal.pending().length) throw new EditError(409, "Resolve interrupted source writes before regenerating GraphQL files.");
  const working = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "studio-codegen-")));
  const artifact = path.join(working, "outputs.json");
  const captured = (name: string) => {
    const bytes = fixedContractBytes(root, name, true);
    if ((bytes && createHash("sha256").update(bytes).digest("hex") || undefined) !== baseline.files[name]?.hash) throw new EditError(409, "Saved source changed while regenerating GraphQL files. Try again.");
    return bytes;
  };
  return {
    artifact,
    publish(output: string): string {
      const result = readCodegenOutputs(artifact, output);
      const current = readSourceManifest(root);
      assertCapturedAuthoredDocuments(root, current.files);
      if (current.digest !== baseline.digest || runtimeContractHash(root) !== database) throw new EditError(409, "Saved source or database artifacts changed during Codegen. Try again to use the current files.");
      const files: Record<string, string> = {};
      const changes: Change[] = [];
      for (const name of Object.keys(baseline.files)) if (contractFileGroup(name) === "generated") files[name] = portableFileDigest(name, captured(name)!);
      for (const [relative, after] of result) {
        assertCodegenWritePath(root, relative);
        const before = captured(relative)?.toString("utf8") ?? null;
        files[relative] = portableFileDigest(relative, Buffer.from(after));
        if (before !== after) changes.push({ relative, before, after });
      }
      const recordText = captured(REVIEW_RECORD_FILE)?.toString("utf8") ?? null;
      const record = currentReviewRecord(recordText === null ? null : parseReviewRecord(recordText));
      const pothos = sourceFingerprints(root).find(node => node.id === "pothos")!;
      const generated = sourceFingerprintsFromFiles(files).find(node => node.id === "generated")!;
      const next = withLedgerEntries(record, [pothos, generated], ["codegen"], new Date().toISOString());
      if (record.ledger?.codegen?.source !== next.ledger!.codegen!.source || record.ledger?.codegen?.output !== next.ledger!.codegen!.output) {
        changes.push({ relative: REVIEW_RECORD_FILE, before: recordText, after: serializeReviewRecord(next) });
      }
      if (!changes.length) return "Generated GraphQL files and their recorded hashes are current.";
      if (readSourceManifest(root).digest !== baseline.digest || runtimeContractHash(root) !== database) throw new EditError(409, "Saved source changed before publishing GraphQL files. Try again.");
      const mutations = changes.map(({ relative, before, after }) => ({ file: assertCodegenWritePath(root, relative), before, after, authority: "graphql-codegen" as const }));
      const id = journal.begin("Regenerate GraphQL files", mutations), written: typeof mutations = [];
      try {
        const apply = (index: number) => {
          const change = mutations[index]!;
          assertCodegenWritePath(root, changes[index]!.relative);
          writeSourceChange(root, change.file, change.before, change.after);
          written.push(change);
        };
        const outputCount = changes.at(-1)?.relative === REVIEW_RECORD_FILE ? mutations.length - 1 : mutations.length;
        for (let index = 0; index < outputCount; index++) apply(index);
        const after = readSourceManifest(root);
        assertCapturedAuthoredDocuments(root, after.files);
        if (runtimeContractHash(root) !== database || changedAgentSourceFiles(baseline, after).some(change => !result.has(change.path))
          || [...result].some(([name, text]) => after.files[name]?.hash !== createHash("sha256").update(text).digest("hex"))) {
          throw new EditError(409, "Saved source changed while publishing GraphQL files. Try again to use current files.");
        }
        if (outputCount < mutations.length) apply(outputCount);
      } catch (error) {
        let conflicted = false;
        for (let index = written.length - 1; index >= 0; index--) try {
          const change = written[index]!;
          assertCodegenWritePath(root, changes[index]!.relative);
          writeSourceChange(root, change.file, change.after, change.before);
        } catch { conflicted = true; }
        journal.finish(id, conflicted ? "conflicted" : "restored");
        if (conflicted) throw new EditError(409, "GraphQL files could not all be restored. Open Source recovery to review concurrent changes.");
        throw error;
      }
      journal.finish(id, "complete");
      return "GraphQL files regenerated and Codegen hashes recorded.";
    },
    cleanup: () => rmSync(working, { recursive: true, force: true }),
  };
}
