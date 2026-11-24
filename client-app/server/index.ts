import { IncompatibleProjectError, resolveStudioProject, resolveStudioProjectRoot } from "./project";
import { describeStudioRelease } from "./project-release";
import { assertWindowsUserContext } from "aws-studio/cli/windows-security";
import { prepareProjectRuntime } from "./project-runtime";

/**
 * `npm run studio`: the Framework Studio server.
 *
 * `npm run studio -- --print` evaluates once and prints the snapshot as JSON,
 * which is the whole model the browser would receive.
 *
 * `--project <dir>` (or STUDIO_PROJECT) opens that project instead of the one containing the
 * working directory. The project is evaluated with the framework it installs.
 */

async function main(): Promise<void> {
  assertWindowsUserContext();
  let args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: studio --project <directory> [--print]\n       studio --create-project <directory> [--name <project-name>] [--print]\n       studio --project <directory> --recover-upgrade [--status | --keep-current <id> <fingerprint>]\n");
    return;
  }
  if (args.includes("--recover-upgrade")) {
    const keep = args.indexOf("--keep-current");
    const status = args.includes("--status");
    const id = keep >= 0 ? args[keep + 1] : undefined;
    const fingerprint = keep >= 0 ? args[keep + 2] : undefined;
    if (keep >= 0 && (status || !id || !/^[a-f0-9-]{36}$/.test(id) || !fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint))) {
      throw new IncompatibleProjectError("--keep-current needs the transaction ID and fingerprint from --recover-upgrade --status.");
    }
    const { recoverInterruptedProjectUpgrades } = await import("./edits/journal");
    const root = resolveStudioProjectRoot({ args, env: process.env, cwd: process.cwd() }, { recovery: true });
    const result = recoverInterruptedProjectUpgrades(root, status ? { status: true } : id && fingerprint ? { id, fingerprint } : undefined);
    process.stdout.write(`${result}\n`);
    return;
  }
  if (args.includes("--create-project")) {
    const index = args.indexOf("--create-project");
    const target = args[index + 1];
    if (!target || target.startsWith("--") || args.includes("--project")) throw new IncompatibleProjectError("Use --create-project <directory> without --project.");
    const nameIndex = args.indexOf("--name");
    const name = nameIndex < 0 ? undefined : args[nameIndex + 1];
    if (nameIndex >= 0 && (!name || name.startsWith("--"))) throw new IncompatibleProjectError("--name needs a lowercase npm package name.");
    const { createStudioProject } = await import("./project-create");
    const created = await createStudioProject(target, name);
    process.stderr.write(`Created project: ${created}\n`);
    args = [...args.filter((_value, position) => position !== index && position !== index + 1 && (nameIndex < 0 || position !== nameIndex && position !== nameIndex + 1)), "--project", created];
  }
  const { root: repositoryRoot } = resolveStudioProject({ args, env: process.env, cwd: process.cwd() });
  const runtime = await prepareProjectRuntime(repositoryRoot);
  process.stderr.write(`Studio runtime: Node ${process.versions.node} (${process.execPath}); project runtime: Node ${runtime.version} (${runtime.node}), npm ${runtime.npmVersion} (${runtime.npm})\n`);
  // The bundled CLI belongs to this installation, so neither the project nor the working directory locates it.
  process.stderr.write(`${describeStudioRelease()}\n`);
  if (args.includes("--print")) {
    const { SnapshotBuilder } = await import("./snapshot");
    const builder = new SnapshotBuilder(repositoryRoot, (line) => process.stderr.write(`${line}\n`));
    try {
      const { snapshot } = await builder.refresh();
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } finally {
      await builder.dispose();
    }
    return;
  }
  process.stderr.write(`Project: ${repositoryRoot}\n`);
  const { startServer } = await import("./server");
  await startServer(repositoryRoot, args);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof IncompatibleProjectError ? error.message : error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
