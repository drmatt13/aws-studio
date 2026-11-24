import { createRequire } from "node:module";
import path from "node:path";
import { defineInputs, listResourceDeclarations, type ResourceReference } from "aws-studio/config";
import type { ProjectDeclarations } from "aws-studio/config/project-declarations";
import type { Mode } from "../../shared/model";

interface Setting {
  readonly key: string;
  readonly fromEnv: string;
  readonly managedBy?: "framework" | "developer";
  readonly values?: readonly string[];
  readonly note?: string;
}

export interface InputMetadata {
  readonly deployment: readonly Setting[];
  readonly local: readonly Setting[];
  readonly required: Readonly<Record<Mode, readonly string[]>>;
  readonly signIn: readonly {
    readonly id: string;
    readonly title: string;
    readonly cognitoName: string;
    readonly keys: readonly string[];
    readonly lines: readonly { readonly name: string; readonly secret: boolean }[];
  }[];
}

export const EMPTY_INPUT_METADATA: InputMetadata = {
  deployment: [], local: [], required: { dev: [], prod: [] }, signIn: [],
};

/** Project-authored declarations execute in the evaluator and return only metadata. */
export function projectInputMetadata(root: string, mode: Mode): InputMetadata {
  const projectRequire = createRequire(path.join(root, "package.json"));
  const { projectDeclarations } = projectRequire("aws-studio/config/project-declarations") as { projectDeclarations(root: string): ProjectDeclarations };
  const declarations = projectDeclarations(root);
  const { deploymentInputs } = declarations.deploymentInputs();
  const { localInputs, REQUIRED_FRAMEWORK_INPUTS } = declarations.frameworkInputs();
  const { SIGN_IN_PROVIDERS, signInProviderKeys } = declarations.signInCatalog();
  const signInInputs = Object.keys(SIGN_IN_PROVIDERS).length
    ? defineInputs(declarations.signInInputs().signInProviders, { mode }) as unknown as Readonly<Record<string, ResourceReference>>
    : {};
  function settings(catalog: Parameters<typeof listResourceDeclarations>[0]): Setting[] {
    return Object.keys(catalog).length ? listResourceDeclarations(catalog).map(reference => ({
      key: reference.path.at(-1)!,
      fromEnv: reference.fromEnv!,
      managedBy: reference.managedBy,
      values: reference.values,
      note: reference.note,
    })) : [];
  }
  return {
    deployment: settings(deploymentInputs(mode)), local: settings(localInputs()), required: REQUIRED_FRAMEWORK_INPUTS,
    signIn: Object.entries(SIGN_IN_PROVIDERS).map(([id, { title, cognitoName }]) => {
      const keys = signInProviderKeys(id);
      return { id, title, cognitoName, keys, lines: keys.flatMap(key => {
        const input = signInInputs[key];
        return input?.fromEnv ? [{ name: input.fromEnv, secret: input.kind === "secret" }] : [];
      }) };
    }),
  };
}
