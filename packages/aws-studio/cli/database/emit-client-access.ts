import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readClientAccess, renderClientAccess, renderRolePolicies } from "aws-studio/database/client-access";
import { ACCESS_POLICY_MODULE, loadAccessModules, renderAccessGraph } from "aws-studio/database/access-graph-artifact";

/**
 * Writes src/generated/client-access.ts (field settings, row rules and write
 * rules), src/generated/access-graph.json (the fingerprinted Access Graph
 * artifact) and @repo/api-contract's roles and abilities from the
 * `/// @access(…)` directives in prisma/contract.prisma and any compatible module declarations in
 * prisma/access. Runs after `prisma contract emit` in this package's generate
 * script. A misplaced or unknown rule fails generation instead of being ignored.
 */
export async function emitClientAccess(packageRoot: string) {
  const contract = path.join(packageRoot, "prisma/contract.prisma");
  const modules = await loadAccessModules(packageRoot);
  const { settings, rows, policy, problems, graph } = readClientAccess(readFileSync(contract, "utf8"), modules);
  if (problems.length) {
    throw new Error(problems.map(problem => {
      const where = problem.code === "AG-POLICY" || problem.code === "AG-COMMAND" ? ACCESS_POLICY_MODULE : `prisma/contract.prisma:${problem.line}${problem.column ? `:${problem.column}` : ""}`;
      return `${where}: ${problem.message}`;
    }).join("\n"));
  }
  const write = (file: string, text: string) => {
    if (existsSync(file) && readFileSync(file, "utf8") === text) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write(path.join(packageRoot, "src/generated/client-access.ts"), renderClientAccess(settings, rows, policy));
  write(path.join(packageRoot, "src/generated/access-graph.json"), renderAccessGraph(graph, modules, packageRoot));
  write(path.resolve(packageRoot, "../api-contract/src/generated/access-policy.ts"), renderRolePolicies(policy));
}
