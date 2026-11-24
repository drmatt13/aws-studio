import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as Framework from "aws-studio/config";
import { PROJECT_DECLARATIONS, projectDeclarations, type DeploymentInputsModule, type FrameworkInputsModule, type SignInCatalogModule, type SignInInputsModule } from "aws-studio/config/project-declarations";
import type * as StatefulResourcesModule from "aws-studio/deploy/stateful-resources";
import type * as StatefulReferencesModule from "aws-studio/deploy/stateful-references";
import { projectExport } from "./project-release";

/**
 * The application modules Studio executes, loaded from the project Studio has open.
 *
 * Their types are the framework's declaration contracts; Studio runs the project's own copies:
 * a project's deployment inputs, sign-in providers, framework settings and lifecycle checks are
 * the project's, at the version of the framework it installs. Each is loaded once per project
 * per Studio process, as a static import was, and its paths are the layout Studio supports.
 * This checkout's copy is never used for another project, not even to fill a gap.
 */
export const PROJECT_LAYOUT = PROJECT_DECLARATIONS;

export interface ProjectModules {
  readonly root: string;
  /** aws-studio/config as the project installs it. */
  framework(): typeof Framework;
  deploymentInputs(): DeploymentInputsModule;
  signInCatalog(): SignInCatalogModule;
  signInInputs(): SignInInputsModule;
  frameworkInputs(): FrameworkInputsModule;
  /** Framework implementations, from the framework the project installs; a framework without one is refused. */
  statefulResources(): typeof StatefulResourcesModule;
  databaseLifecycle(): typeof StatefulReferencesModule;
  cognitoLifecycle(): typeof StatefulReferencesModule;
}

const projects = new Map<string, ProjectModules>();

/** The opened project's modules, one set per real project directory. */
export function projectModules(root: string): ProjectModules {
  const real = realpathSync(root);
  let modules = projects.get(real);
  if (!modules) projects.set(real, modules = load(real));
  return modules;
}

function load(root: string): ProjectModules {
  const projectRequire = createRequire(path.join(root, "package.json"));
  const declarations = projectDeclarations(root);
  return {
    root,
    framework: () => projectRequire(projectExport(root, "config")) as typeof Framework,
    deploymentInputs: declarations.deploymentInputs,
    signInCatalog: declarations.signInCatalog,
    signInInputs: declarations.signInInputs,
    frameworkInputs: declarations.frameworkInputs,
    statefulResources: () => projectFrameworkModule<typeof StatefulResourcesModule>(root, "deploy/stateful-resources"),
    databaseLifecycle: () => projectFrameworkModule<typeof StatefulReferencesModule>(root, "deploy/stateful-references"),
    cognitoLifecycle: () => projectFrameworkModule<typeof StatefulReferencesModule>(root, "deploy/stateful-references"),
  };
}

/**
 * A framework module as the project installs it. A project whose framework predates the module, or
 * that installs none, is refused by name instead of borrowing this checkout's copy.
 */
export function projectFrameworkModule<T>(root: string, subpath: string): T {
  return createRequire(path.join(root, "package.json"))(projectExport(root, subpath)) as T;
}
