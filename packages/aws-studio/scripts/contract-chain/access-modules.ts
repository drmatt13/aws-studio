import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerAccessModules, type AccessModules } from "../../database/client-access";
import { ACCESS_POLICY_MODULE, policyModuleDigest } from "../../database/access-graph-artifact";

const loaded = new Map<string, { readonly digest: string; readonly modules: AccessModules }>();

/**
 * The application's access policy module (packages/database/prisma/access),
 * compiled from its saved source: contract.prisma's Access Graph directives
 * name its guards, permissions and commands, so Studio and Contract Chain read
 * every draft with it. The import is keyed by the module's content digest, so
 * this long-running server sees an edit without a restart, and a clean
 * checkout needs no generated artifact.
 */
export async function sourceAccessModules(root: string): Promise<AccessModules | undefined> {
  const packageRoot = path.join(root, "packages/database");
  const file = path.join(packageRoot, ACCESS_POLICY_MODULE);
  if (!existsSync(file)) return undefined;
  const digest = policyModuleDigest(packageRoot);
  const cached = loaded.get(file);
  if (cached?.digest === digest) return cached.modules;
  const module = (await import(`${pathToFileURL(file).href}?digest=${digest}`)) as { default?: AccessModules };
  if (!module.default || typeof module.default !== "object") throw new Error(`${ACCESS_POLICY_MODULE} must export default defineAccessPolicy({ … }).`);
  loaded.set(file, { digest, modules: module.default });
  return module.default;
}

/** Makes every access read in this process use the repository's policy module, as saved. */
export async function applySourceAccessModules(root: string): Promise<AccessModules | undefined> {
  const modules = await sourceAccessModules(root);
  registerAccessModules(modules);
  return modules;
}
