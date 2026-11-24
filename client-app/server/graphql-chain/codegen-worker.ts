import { createRequire } from "node:module";
import path from "node:path";
import { writeEvaluationArtifact } from "aws-studio/source/result-artifact";
import { documentProjectionOptions, inspectAuthoredDocumentSyntax, readAuthoredDocumentSources } from "aws-studio/contract-chain/authored-documents";
import { fixedCodegen } from "aws-studio/contract-chain/codegen-config";
import { CODEGEN_ARTIFACT_MARKER } from "./codegen-files";

async function run() {
  const root = process.cwd(), file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error("A private Codegen output file is required.");
  const require = createRequire(path.join(root, "package.json"));
  const graphql = require("graphql") as typeof import("graphql");
  const { config, context, generate } = await fixedCodegen(root);
  if (!graphql.isSchema(config.schema) || !documentProjectionOptions(config)
    || Object.values(config.generates).some((output: any) => output.schema || output.documents || output.plugins?.some((plugin: unknown) => plugin !== "schema-ast"))) {
    throw new Error("Codegen requires the local executable schema and the fixed authored document loader.");
  }
  graphql.assertValidSchema(config.schema);
  inspectAuthoredDocumentSyntax(root, readAuthoredDocumentSources(root));
  const outputs: readonly { filename: string; content: string }[] = await generate(context, false);
  const files = outputs.map(({ filename, content }) => ({ filename: path.relative(root, path.resolve(root, filename)).split(path.sep).join("/"), content }));
  process.stdout.write(`\n${CODEGEN_ARTIFACT_MARKER}${JSON.stringify(writeEvaluationArtifact(file, files))}\n`);
}

void run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
