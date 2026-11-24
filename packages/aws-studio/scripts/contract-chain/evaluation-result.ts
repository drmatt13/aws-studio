import { isDocumentPluckOptions } from "./authored-documents";
import type { ChainEvaluation } from "./worker";

/** Validate data-only output without importing host execution infrastructure. */
export function parseChainEvaluation(text: string): ChainEvaluation {
  const value = JSON.parse(text) as ChainEvaluation;
  const diagnostics = (items: unknown) => Array.isArray(items) && items.length <= 1000 && items.every(item => item && typeof item.code === "string" && typeof item.message === "string" && item.message.length <= 4000 && (item.file === undefined || typeof item.file === "string") && (item.line === undefined || Number.isSafeInteger(item.line)) && (item.column === undefined || Number.isSafeInteger(item.column)));
  const check = (item: unknown): boolean => !!item && typeof item === "object" && ("status" in item) && (item.status === "passed" || (["failed", "blocked", "unavailable"].includes(String(item.status)) && "diagnostics" in item && diagnostics(item.diagnostics)));
  if (!value || !(value.sdl === null || typeof value.sdl === "string") || !(value.generatedSdl === null || typeof value.generatedSdl === "string")
    || !diagnostics(value.schemaDiagnostics) || !diagnostics(value.generatedDiagnostics) || !diagnostics(value.documentDiagnostics)
    || !["matches", "differs", "unknown"].includes(value.documentSet) || !Array.isArray(value.documents) || value.documents.length > 1000
    || value.authoredDocumentsDigest !== undefined && value.authoredDocumentsDigest !== null && !/^[a-f0-9]{64}$/.test(value.authoredDocumentsDigest)
    || value.documentProjectionOptions !== undefined && value.documentProjectionOptions !== null && !isDocumentPluckOptions(value.documentProjectionOptions)
    || value.documents.some(item => !item || typeof item.document !== "string" || typeof item.file !== "string" || typeof item.message !== "string" || !(item.line === null || Number.isSafeInteger(item.line)))
    || !value.codegen || !["current", "out-of-date", "unknown"].includes(value.codegen.status) || !diagnostics(value.codegen.diagnostics)
    || !Array.isArray(value.codegen.files) || value.codegen.files.some(file => typeof file !== "string" || !file.startsWith("client-app/src/api/generated/") || file.includes(".."))
    || !value.verification || ["database", "api", "client", "consumers", "integration"].some(key => !check(value.verification[key as keyof typeof value.verification]))
    || !(value.contract === null || value.contract && /^[a-f0-9]{64}$/.test(value.contract.storageHash) && (value.contract.executionHash === null || /^[a-f0-9]{64}$/.test(value.contract.executionHash)))
    || value.verification.database.status === "passed" && value.contract === null) throw new Error("Restricted GraphQL evaluation returned an invalid artifact.");
  return value;
}

