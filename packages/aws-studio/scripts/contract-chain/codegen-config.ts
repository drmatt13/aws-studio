import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Load the fixed local generator in a child. Tool settings cannot introduce hooks or new output paths. */
export async function fixedCodegen(root: string) {
  const localRequire = createRequire(path.join(root, "package.json"));
  const module = await import(pathToFileURL(path.join(root, "codegen.ts")).href);
  const config = module.default?.default ?? module.default;
  const outputPaths = ["client-app/src/api/generated/", "client-app/src/api/generated/schema.graphql"];
  const client = config?.generates?.[outputPaths[0]!], schema = config?.generates?.[outputPaths[1]!];
  if (!config || config.watch || config.hooks || config.profile || config.require || config.allowPartialOutputs || (config.overwrite !== undefined && config.overwrite !== true)
    || JSON.stringify(config.documents) !== JSON.stringify(["client-app/src/api/**/*.ts", "!client-app/src/api/generated/**"])
    || JSON.stringify(Object.keys(config.generates ?? {}).sort()) !== JSON.stringify(outputPaths)
    || client?.preset !== "client" || client?.config?.documentMode !== "string"
    || client?.presetConfig?.fragmentMasking !== false || client?.presetConfig?.persistedDocuments?.hashAlgorithm !== "sha256"
    || JSON.stringify(schema?.plugins) !== JSON.stringify(["schema-ast"]) || schema?.config?.includeDirectives !== true
    || Object.values(config.generates ?? {}).some((value: any) => value?.hooks || (value?.overwrite !== undefined && value?.overwrite !== true))) {
    throw new Error("This Codegen configuration is unsupported by the fixed read-only check. Keep both fixed outputs, typed-string client documents, unmasked fragments, sha256 persisted documents and the directive-aware schema output. Hooks, watch, profiling and custom paths require source review.");
  }
  const { CodegenContext, generate } = localRequire("@graphql-codegen/cli") as typeof import("@graphql-codegen/cli");
  const safeConfig = { ...config, noRequire: true, config: { ...config.config, noRequire: true } };
  const context = new CodegenContext({ config: safeConfig, filepath: path.join(root, "codegen.ts") });
  context.cwd = root;
  return { config, context, generate };
}
