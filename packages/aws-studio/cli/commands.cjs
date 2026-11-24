const chain = "scripts/contract-chain/cli.ts";
const generation = "scripts/generate-contracts.ts";
const adapter = "cli/database/project-adapter.ts";
// Every step is a fixed release file, project npm script, or Node test. Only
// the final step receives the caller's arguments, as separate argv elements.
module.exports = {
  verify: [[chain, "verify"]],
  record: [[chain, "record"]],
  init: [[chain, "init"]],
  dev: [["cli/dev.mjs"]],
  "dev:docker-desktop": [["cli/docker-desktop-start.mjs"]],
  "dev:observe": [["cli/dev-observation.ts"]],
  "dev:request": [["cli/dev-request.ts"]],
  deploy: [["cli/deploy.ts"]],
  destroy: [["cli/destroy.ts"]],
  "deploy:status": [["cli/deployment-status.ts"]],
  "stateful:references": [["cli/stateful-references.ts"]],
  "export:cdk-outputs": [["cli/export-cdk-outputs.mjs"]],
  "task:cloud": [["cli/run-cloud-task.ts"]],
  "db:migrate:cloud": [["cli/run-cloud-task.ts", "db-migrate"]],
  "db:generate": [["cli/database/generate.ts"]],
  "db:scaffold": [["cli/database/scaffold-cli.ts"]],
  "db:prepare-local": [["cli/database/prepare-local-database-cli.ts"]],
  "db:copy-configuration-inputs": [["cli/database/copy-configuration-inputs.ts"]],
  "db:seed-test-user": [[adapter, "seedTestUser"]],
  "db:prune-cognito-orphans": [[adapter, "pruneCognitoOrphans"]],
  "replay:list": [["cli/replay.ts", "list"]],
  "replay:redrive": [["cli/replay.ts", "redrive"]],
  "framework:generate": [[generation]],
  "framework:check-local": [["scripts/check-local.ts"]],
  "framework:check": [[generation, "--check"], ["scripts/check-local.ts"]],
  "workflows:inspect": [["scripts/inspect-workflows.ts"]],
  "agents:inspect": [["scripts/inspect-agents.ts"]],
  "agents:smoke": [["cli/agents-smoke.ts"]],
  "infrastructure:identity": [["cli/infrastructure-identity.ts"]],
  "lockfile:check": [["cli/check-lockfile-platforms.mjs"]],
  contract: [["npm", "run", "framework:generate"], ["npm", "--workspace", "@repo/database", "run", "generate"], ["npm", "run", "codegen"], ["npm", "run", "typecheck"]],
  "project:verify": [
    ["cli/check-lockfile-platforms.mjs"], ["npm", "run", "framework:check"],
    ["npm", "--workspace", "@repo/database", "run", "generate"], ["npm", "run", "codegen:check"],
    ["npm", "run", "typecheck"], ["node-test", "compute/http/graphql-api/schema/*.test.ts"],
    ["npm", "test"], [chain, "verify"],
  ],
};
