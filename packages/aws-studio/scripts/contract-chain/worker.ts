import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ChainVerification, CheckEvidence, Diagnostic, DocumentProblem } from "./graphql-chain";
import { readEvaluationArtifact, writeEvaluationArtifact } from "../source/result-artifact";
import { parseChainEvaluation } from "./evaluation-result";
import { combineVerification, skippedVerification, unavailableVerification, VERIFICATION_PHASES, verifyPhase, type PhaseEvidence, type VerificationPhase } from "./verification";

import { documentProjectionOptions, inspectAuthoredDocumentSyntax, readAuthoredDocumentSources, type DocumentPluckOptions } from "./authored-documents";
import { fixedCodegen } from "./codegen-config";

export interface ChainEvaluation {
  verification: ChainVerification;
  contract: { storageHash: string; executionHash: string | null } | null;
  sdl: string | null;
  schemaDiagnostics: Diagnostic[];
  generatedSdl: string | null;
  generatedDiagnostics: Diagnostic[];
  documents: DocumentProblem[];
  documentDiagnostics: Diagnostic[];
  documentSet: "matches" | "differs" | "unknown";
  /** Actual discovered source literals, without cache/transport implementation. */
  authoredDocumentsDigest?: string | null;
  /** Data-only settings from the actual Codegen loader; null declines fast projection. */
  documentProjectionOptions?: DocumentPluckOptions | null;
  codegen: { status: "current" | "out-of-date" | "unknown"; files: string[]; diagnostics: Diagnostic[] };
}

/** This module is pinned by the host; application imports happen only in the child. */
export async function inspectGraphQLChain(root: string): Promise<ChainEvaluation> {
  const localRequire = createRequire(path.join(root, "package.json"));
  const schemaFile = "compute/http/graphql-api/schema/index.ts";
  const schemaRequire = createRequire(path.join(root, schemaFile));
  const graphql = schemaRequire("graphql") as typeof import("graphql");
  const ts = localRequire("typescript") as typeof import("typescript");
  const relative = (file: string) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
  const diagnostic = (code: string, error: unknown, file?: string): Diagnostic => {
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(root + path.sep, "").slice(0, 4000);
    const match = /(?:^|\n)([^\n]*?\.(?:ts|tsx|js)):(\d+):(\d+)/.exec(message);
    return { code, message, ...(file ? { file } : {}), ...(match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : {}) };
  };
  const unknown = unavailableVerification("Independent validation has not run for this source capture.");
  const result: ChainEvaluation = { verification: { database: unknown, api: unknown, client: unknown, consumers: unknown, integration: unknown }, contract: null, sdl: null, schemaDiagnostics: [], generatedSdl: null, generatedDiagnostics: [], documents: [], documentDiagnostics: [], documentSet: "unknown", codegen: { status: "unknown", files: [], diagnostics: [] } };
  let schema: import("graphql").GraphQLSchema | undefined;
  try {
    const loaded = await import(pathToFileURL(path.join(root, schemaFile)).href);
    schema = loaded.schema ?? loaded.default?.schema;
    if (!schema || !graphql.isSchema(schema)) throw new Error("The fixed schema entry did not export a GraphQL schema.");
    graphql.assertValidSchema(schema);
    result.sdl = graphql.printSchema(graphql.lexicographicSortSchema(schema));
  } catch (error) { result.schemaDiagnostics.push(diagnostic("SCHEMA_EVALUATION", error, schemaFile)); }
  try {
    result.generatedSdl = graphql.printSchema(graphql.lexicographicSortSchema(graphql.buildSchema(readFileSync(path.join(root, "client-app/src/api/generated/schema.graphql"), "utf8"))));
  } catch (error) { result.generatedDiagnostics.push(diagnostic("GENERATED_SCHEMA", error, "client-app/src/api/generated/schema.graphql")); }
  try {
    const { config, context, generate } = await fixedCodegen(root);
    const documentOptions = documentProjectionOptions(config);
    // Pluck with the actual Codegen loader; never execute operations or tests.
    const authored = new Set<string>();
    const definitions: import("graphql").DefinitionNode[] = [];
    // Validate actual literal syntax before Codegen's loader wraps syntax errors
    // together with configuration/discovery failures in a generic Error.
    const documentSources = readAuthoredDocumentSources(root);
    inspectAuthoredDocumentSyntax(root, documentSources);
    const sources = await context.loadDocuments(config.documents, "standard");
    for (const source of sources) {
      if (!source.rawSDL) throw new Error("A document loader returned no authored source text.");
      const sourceFile = relative(source.location ?? "client-app/src/api");
      let document: import("graphql").DocumentNode;
      try { document = graphql.parse(new graphql.Source(source.rawSDL, sourceFile)); }
      catch (error) {
        result.documentDiagnostics.push(diagnostic("DOCUMENT_SYNTAX", error, sourceFile));
        throw error;
      }
      if (document.definitions.some(definition => definition.kind === "OperationDefinition" || definition.kind === "FragmentDefinition")) authored.add(source.rawSDL.replaceAll("\r\n", "\n"));
      definitions.push(...document.definitions);
    }
    inspectAuthoredDocumentSyntax(root, documentSources, authored);
    const syntax = ts.createSourceFile("gql.ts", readFileSync(path.join(root, "client-app/src/api/generated/gql.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    let typeKeys: Set<string> | undefined, runtimeKeys: Set<string> | undefined;
    for (const statement of syntax.statements) {
      if (ts.isTypeAliasDeclaration(statement) && statement.name.text === "Documents" && ts.isTypeLiteralNode(statement.type)) {
        typeKeys = new Set(statement.type.members.map(member => {
          if (!member.name || !ts.isStringLiteral(member.name)) throw new Error("Unsupported generated Documents map.");
          return member.name.text;
        }));
      }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "documents" && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) runtimeKeys = new Set(declaration.initializer.properties.map(property => {
          if (!property.name || !ts.isStringLiteral(property.name)) throw new Error("Unsupported generated documents map.");
          return property.name.text;
        }));
      }
    }
    if (!typeKeys || !runtimeKeys) throw new Error("The generated document maps are unavailable.");
    const same = (keys: Set<string>) => keys.size === authored.size && [...authored].every(key => keys.has(key));
    result.documentSet = same(typeKeys) && same(runtimeKeys) ? "matches" : "differs";
    result.documentProjectionOptions = documentOptions;
    result.authoredDocumentsDigest = createHash("sha256").update(JSON.stringify([...authored].sort())).digest("hex");
    if (schema) {
      const combined: import("graphql").DocumentNode = { kind: graphql.Kind.DOCUMENT, definitions };
      result.documents = graphql.validate(schema, combined).map(error => {
        const node = error.nodes?.[0], source = node?.loc?.source;
        const owner = definitions.find(definition => definition.loc && definition.loc.source === source && node?.loc && definition.loc.start <= node.loc.start && definition.loc.end >= node.loc.end);
        return { document: owner && "name" in owner ? owner.name?.value ?? "Anonymous operation" : "GraphQL document", file: source?.name ?? "client-app/src/api", line: error.locations?.[0]?.line ?? null, message: error.message.slice(0, 4000) };
      });
    }
    try {
      context.enableCheckMode();
      await generate(context, true);
      result.codegen = { status: context.checkModeStaleFiles.length ? "out-of-date" : "current", files: context.checkModeStaleFiles.map(relative).sort(), diagnostics: [] };
    } catch (error) { result.codegen.diagnostics.push(diagnostic("CODEGEN_CHECK", error, "codegen.ts")); }
  } catch (error) {
    if (error instanceof graphql.GraphQLError && error.source) result.documentDiagnostics.push(diagnostic("DOCUMENT_SYNTAX", error, error.source.name));
    const issue = diagnostic("DOCUMENT_EVIDENCE", error);
    result.documentDiagnostics.push(issue); result.codegen.diagnostics.push(issue);
  }
  return result;
}

export function integrationPrerequisite(value: Pick<ChainEvaluation, "codegen" | "documentSet" | "documents">): CheckEvidence | null {
  if (value.codegen.status === "current" && value.documentSet === "matches" && !value.documents.length) return null;
  const knownFailure = value.codegen.status === "out-of-date" || value.documentSet === "differs" || value.documents.length > 0;
  return skippedVerification(knownFailure ? { status: "failed", diagnostics: [] } : unavailableVerification("Codegen evidence is unavailable."), "Regenerate current GraphQL documents and resolve their validation errors before checking API/client integration.");
}

/** Reuse the fixed worker/artifact protocol while keeping authored globals out of
 * the process that launches and combines independent verification phases. */
const executeWorker = promisify(execFile);
async function childArtifact(root: string, scratch: string, mode: VerificationPhase | "inspect"): Promise<string> {
  const script = process.argv[1]!;
  const reporter = path.join(path.dirname(script), "node-test-reporter.cjs");
  const loader = pathToFileURL(createRequire(path.join(root, "package.json")).resolve("tsx")).href;
  const directory = path.join(scratch, mode); mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, "result.json");
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_DISABLE_CACHE: "1" }; delete env.NODE_TEST_CONTEXT;
  const { stdout } = await executeWorker(process.execPath, ["--import", loader, script, file, mode, reporter], { cwd: root, encoding: "utf8", env, timeout: 120_000, maxBuffer: 32_768, windowsHide: true });
  return readEvaluationArtifact(file, JSON.parse(stdout), 2 * 1024 * 1024);
}

/** Child phases share the immutable capture and native policy, never module state. */
async function independentVerification(root: string, scratch: string): Promise<ChainEvaluation> {
  const phase = async (name: VerificationPhase): Promise<PhaseEvidence> => {
    try {
      const proof = JSON.parse(await childArtifact(root, scratch, name)) as PhaseEvidence;
      if (!proof || !["passed", "failed", "blocked", "unavailable"].includes(proof.evidence?.status)) throw new Error("Invalid phase evidence");
      return proof;
    } catch { return { evidence: unavailableVerification(`Independent ${name} validation returned incomplete evidence. Check again after resolving the validator failure.`) }; }
  };
  const [database, inspection] = await Promise.all([phase("database"), childArtifact(root, scratch, "inspect")]);
  const value = parseChainEvaluation(inspection);
  value.contract = database.contract ?? null;
  // Keep at most two phases active. API checks need database evidence and
  // integration needs current generated documents; the client checks can
  // run alongside the API lane in a separate scratch directory.
  const api = (async () => {
    if (database.evidence.status !== "passed") return skippedVerification(database.evidence, "Current emitted database artifacts are required before repository and API validation can establish proof.");
    const behavior = await phase("api"), types = await phase("api-types");
    return combineVerification([behavior.evidence, types.evidence]);
  })();
  const client = await phase("client"), consumers = await phase("consumers");
  const integration = integrationPrerequisite(value) ?? (await phase("integration")).evidence;
  value.verification = { database: database.evidence, api: await api, client: client.evidence, consumers: consumers.evidence, integration };
  return value;
}

export async function runChainWorker(artifact: string, phase?: string, reporter?: string): Promise<void> {
  const output = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    let value: unknown;
    if (phase === "inspect") {
      value = await inspectGraphQLChain(process.cwd());
    } else if (phase !== undefined) {
      if (!VERIFICATION_PHASES.includes(phase as VerificationPhase) || !reporter) throw new Error("Unsupported verification phase");
      value = await verifyPhase(process.cwd(), phase as VerificationPhase, path.dirname(artifact), reporter);
    } else {
      value = await independentVerification(process.cwd(), path.dirname(artifact));
    }
    const receipt = writeEvaluationArtifact(artifact, value, 2 * 1024 * 1024);
    output(JSON.stringify(receipt) + "\n", () => process.exit(0));
  } catch { process.exit(2); }
}
