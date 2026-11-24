import { fileURLToPath } from "node:url";
import { runProjectCommand } from "aws-studio/cli/project-node.mjs";

try {
  runProjectCommand(fileURLToPath(new URL("../", import.meta.url)), process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
