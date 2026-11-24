import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { CloudMode, InputDeclarationInput, ResourceReference, defineInputs } from "./resources";

/**
 * Application declaration modules the platform reads: the project's deployment settings, sign-in
 * catalog and inputs, and local tooling settings. Each project declares its own, or omits one and
 * declares nothing there. The platform loads them from the project it serves, at these paths, and
 * never imports them, so deployment and Studio work for any project.
 */
export const PROJECT_DECLARATIONS = {
  deploymentInputs: "framework-config/inputs/deployment.ts",
  signInCatalog: "framework-config/auth/sign-in-providers.ts",
  signInInputs: "framework-config/inputs/sign-in-providers.ts",
  frameworkInputs: "cdk-app/framework-inputs.ts",
} as const;

/** A catalog as `defineInputs` returns it. */
export type DeclaredInputs = ReturnType<typeof defineInputs<InputDeclarationInput>>;

export interface DeploymentInputsModule { deploymentInputs(mode: CloudMode): DeclaredInputs }

export interface SignInProviderEntry {
  readonly title: string;
  /** The Cognito identity provider name; the hosted UI's `identity_provider` parameter. */
  readonly cognitoName: string;
  /** Non-secret settings: field name to input key. */
  readonly settings: Readonly<Record<string, string>>;
  readonly secret: string;
}

export interface SignInCatalogModule {
  readonly SIGN_IN_PROVIDERS: Readonly<Record<string, SignInProviderEntry>>;
  /** Every input key a provider reads, its secret last. */
  signInProviderKeys(id: string): readonly string[];
}

export interface SignInInputsModule { readonly signInProviders: InputDeclarationInput }

export interface FrameworkInputsModule {
  localInputs(): DeclaredInputs;
  readonly REQUIRED_FRAMEWORK_INPUTS: Readonly<Record<CloudMode, readonly string[]>>;
  localTestAccountInputs?(inputs: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>>;
}

/** Each enabled provider's resolved non-secret settings, by provider id. */
export type SignInProviderSettings = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface ProjectDeclarations {
  deploymentInputs(): DeploymentInputsModule;
  signInCatalog(): SignInCatalogModule;
  signInInputs(): SignInInputsModule;
  frameworkInputs(): FrameworkInputsModule;
}

/** What omitting each declaration module declares: nothing. */
export const UNDECLARED_PROJECT_DECLARATIONS: { readonly [Key in keyof ProjectDeclarations]: ReturnType<ProjectDeclarations[Key]> } = {
  deploymentInputs: { deploymentInputs: () => ({}) as DeclaredInputs },
  signInCatalog: { SIGN_IN_PROVIDERS: {}, signInProviderKeys: () => [] },
  signInInputs: { signInProviders: {} },
  frameworkInputs: { localInputs: () => ({}) as DeclaredInputs, REQUIRED_FRAMEWORK_INPUTS: { dev: [], prod: [] } },
};

/** The declaration modules of the project at `root`, each loaded on first use. */
export function projectDeclarations(root: string): ProjectDeclarations {
  const projectRequire = createRequire(path.join(root, "package.json"));
  const declared = <Key extends keyof ProjectDeclarations>(key: Key) => (): ReturnType<ProjectDeclarations[Key]> => {
    const file = path.join(root, PROJECT_DECLARATIONS[key]);
    return (existsSync(file) ? projectRequire(file) : UNDECLARED_PROJECT_DECLARATIONS[key]) as ReturnType<ProjectDeclarations[Key]>;
  };
  return {
    deploymentInputs: declared("deploymentInputs"),
    signInCatalog: declared("signInCatalog"),
    signInInputs: declared("signInInputs"),
    frameworkInputs: declared("frameworkInputs"),
  };
}

/** The deployment settings `aws-studio/cdk/deployment` reads from `framework-config/inputs/deployment.ts`. */
export const DEPLOYMENT_SETTING_KEYS = [
  "cognitoDomainCertificateArn",
  "cognitoDomainName",
  "cognitoSesFromEmail",
  "cognitoSesFromName",
  "cognitoSesRegion",
  "frontendCloudFrontCertificateArn",
  "frontendUrl",
  "localDevUrl",
  "prodCloudFrontCertificateArn",
  "prodUrl",
  "retainStatefulResources",
  "skipEmailVerification",
  "useCognitoCustomDomain",
  "useFrontendCustomDomain",
] as const;

export type DeploymentSettingKey = (typeof DEPLOYMENT_SETTING_KEYS)[number];

/** A project's deployment settings, refused by name when one that deployment reads is not declared. */
export function requireDeploymentSettings(catalog: DeclaredInputs): Readonly<Record<DeploymentSettingKey, ResourceReference>> {
  const entries = catalog as Readonly<Record<string, ResourceReference | undefined>>;
  for (const key of DEPLOYMENT_SETTING_KEYS) {
    if (!entries[key]) throw new Error(`${PROJECT_DECLARATIONS.deploymentInputs} does not declare ${key}, which deployment reads.`);
  }
  return entries as Readonly<Record<DeploymentSettingKey, ResourceReference>>;
}
