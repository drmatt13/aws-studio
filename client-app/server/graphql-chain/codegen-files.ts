import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { EditError } from "aws-studio/source/errors";

export const GRAPHQL_GENERATED_FILES = ["gql.ts", "graphql.ts", "index.ts", "persisted-documents.json", "schema.graphql"]
  .map(name => `client-app/src/api/generated/${name}`);

export const CODEGEN_ARTIFACT_MARKER = "STUDIO_CODEGEN_ARTIFACT ";

export function assertCodegenWritePath(root: string, relative: string): string {
  if (relative !== "graphql-chain.review.json" && !GRAPHQL_GENERATED_FILES.includes(relative)) throw new EditError(422, "This path is outside GraphQL Codegen's generated files and ledger.");
  let file = realpathSync(root);
  for (const segment of relative.split("/")) {
    file = path.join(file, segment);
    try { if (lstatSync(file).isSymbolicLink()) throw new EditError(422, "GraphQL Codegen cannot write through a symbolic link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return file;
}
