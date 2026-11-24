import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  getLambdaSection,
  getLambdaTargetIds,
  isNodeLambdaRuntime,
  resolveLambdaTarget,
  validateFrameworkConfig,
} from "aws-studio/config";
import { findRepositoryRoot, resolveAgentSourcePath, resolveLambdaSourcePath } from "aws-studio/config/source";
import { loadFrameworkConfig } from "../src/config/source";
import { planLocalInvocation } from "../src/local/invocation";
import { assertEventReplayEntry } from "./check-event-replay";
import { assertAgentCoreEntries } from "./check-agentcore";
import { assertCognitoVerifierInputs } from "./check-auth";
import { GENERATED_COMPOSE_FILE, parseCompose, readProjectCompose } from "./compose-services";
import { INPUT_TEMPLATES, undocumentedRequiredInputs } from "./check-repository";
import { assertWorkflowAuthoringIsSupported } from "./check-workflow-authoring";
import { LOCAL_HOST_PORT_NAMES } from "../cli/local-export";

// The project this runs for, loaded by root: see loadFrameworkConfig.
const framework = loadFrameworkConfig();

const repositoryRoot = findRepositoryRoot(process.cwd());
validateFrameworkConfig(framework);
planLocalInvocation(framework, { repositoryRoot });
// Syntactic, and before anything is built: a symbolic value used as a
// JavaScript condition compiles to a constant, and by the time a workflow runs
// there is nothing left to notice.
assertWorkflowAuthoringIsSupported(path.join(repositoryRoot, "framework-config"));
// Each locally run service's container — declared in docker-compose.yml, or
// generated into docker-compose.services.yml — is checked by framework:generate
// (compose-services.ts), which `framework:check` runs before this file.
const authored = readProjectCompose(repositoryRoot);
const generatedFile = path.join(repositoryRoot, GENERATED_COMPOSE_FILE);
const compose = {
  services: {
    ...(existsSync(generatedFile) ? parseCompose(readFileSync(generatedFile, "utf8")).services : {}),
    ...authored.services,
  },
};

// Published host ports are authored in cdk-app/.env.dev and interpolated by name, so
// a service that publishes a literal cannot be moved off a port the developer's
// machine already uses. Both directions are checked: a service publishing a name
// the export does not write would resolve to nothing, and a name the export
// writes for no service is dead. Container ports are absent — they cannot collide.
const portNames = new Set<string>(LOCAL_HOST_PORT_NAMES);
const publishedBy = new Map<string, string>();
for (const [name, service] of Object.entries(compose.services ?? {}) as [string, any][]) {
  for (const entry of (service?.ports ?? []) as string[]) {
    const hostPort = entry.split(":").slice(-2)[0];
    const variable = /^\$\{([A-Z0-9_]+)\}$/.exec(hostPort)?.[1];
    if (!variable) {
      throw new Error(`docker-compose.yml service "${name}" publishes ${entry} on a literal host port. Use one of the \${...} names cdk-app/.env.dev authors so it can be moved.`);
    }
    if (!portNames.has(variable)) {
      throw new Error(`docker-compose.yml service "${name}" publishes \${${variable}}, which npm run export:cdk-outputs never writes. Add it to LOCAL_HOST_PORT_NAMES in aws-studio/cli/local-export.ts and to cdk-app/.env.dev.template.`);
    }
    publishedBy.set(variable, name);
  }
}
for (const variable of portNames) {
  if (!publishedBy.has(variable)) {
    throw new Error(`${variable} is exported for a host port no docker-compose.yml service publishes. Remove it from LOCAL_HOST_PORT_NAMES in aws-studio/cli/local-export.ts.`);
  }
}

// ---------------------------------------------------------------------------
// An input a workload cannot run without is listed in the template for the
// graph that runs it, so the next person to copy one learns it exists. See
// check-repository.ts. A template that is not there is not demanded.
// ---------------------------------------------------------------------------
const templates = Object.entries(INPUT_TEMPLATES)
  .filter(([file]) => existsSync(path.join(repositoryRoot, file)))
  .map(([file, graph]) => ({ file, graph, text: readFileSync(path.join(repositoryRoot, file), "utf8") }));
const undocumented = undocumentedRequiredInputs(framework, templates);
if (undocumented.length > 0) throw new Error(undocumented.join("\n"));

// ---------------------------------------------------------------------------
// `localReplay: true` is the whole feature, so the handler half is checked.
//
// Without the wrapper a dev deployment would run the handler in AWS, where it
// has none of what the local lane gives it (no database, in this repository),
// and the failure would surface inside whatever invoked it — a Cognito
// sign-up, say. The reverse is refused too: a wrapper on an event without the
// flag never captures, which reads as capture silently not working.
// ---------------------------------------------------------------------------
for (const id of getLambdaTargetIds(framework)) {
  if (getLambdaSection(framework, id) !== "events") continue;
  const spec = resolveLambdaTarget(framework, id);
  if (spec.packaging !== "zip" || !isNodeLambdaRuntime(spec.runtime)) continue;
  const entry = path.join(resolveLambdaSourcePath(framework, id, { repositoryRoot }), "index.ts");
  if (!existsSync(entry)) continue;
  assertEventReplayEntry(id, spec.localReplay === true, readFileSync(entry, "utf8"));
}

// ---------------------------------------------------------------------------
// A tool's `auth: true` and an agent's id are paired with their entry points,
// for the same reason as localReplay above. See check-agentcore.ts.
// ---------------------------------------------------------------------------
assertAgentCoreEntries(framework, (reference) => {
  const [kind, id] = reference.split(":");
  const directory =
    kind === "agent"
      ? resolveAgentSourcePath(framework, id, { repositoryRoot })
      : resolveLambdaSourcePath(framework, id, { repositoryRoot });
  const entry = path.join(directory, "index.ts");
  return existsSync(entry) ? readFileSync(entry, "utf8") : undefined;
});

// ---------------------------------------------------------------------------
// A handler that verifies a user declares the pool it verifies against. See
// check-auth.ts.
// ---------------------------------------------------------------------------
assertCognitoVerifierInputs(framework, (reference) => {
  const entry = path.join(resolveLambdaSourcePath(framework, reference.slice("lambda:".length), { repositoryRoot }), "index.ts");
  return existsSync(entry) ? readFileSync(entry, "utf8") : undefined;
});

// ---------------------------------------------------------------------------
// The catalog stays free of CDK at runtime.
//
// `stack<T>()` reads a stack class for its public fields, which means
// framework-config imports from cdk-app. That is safe only while those imports
// are erased: this config is loaded by CDK synthesis, by both local dev
// servers, by the invocation runner and by the local service launcher, and a
// value import would carry the whole of aws-cdk-lib into every one of them.
// `import type` costs nothing; `import` costs ~100MB.
// ---------------------------------------------------------------------------
const CDK_VALUE_IMPORT =
  /^(?!.*\bimport\s+type\b)\s*import\s+(?!type\b)[^;]*?from\s*["'](aws-cdk-lib[^"']*|constructs)["']/gm;
for (const configDirectory of [path.join(repositoryRoot, "framework-config"), path.resolve(__dirname, "../src/config")]) {
  for (const file of readdirSync(configDirectory, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    const modulePath = path.join(configDirectory, file);
    const source = readFileSync(modulePath, "utf8");
    const offender = CDK_VALUE_IMPORT.exec(source);
    CDK_VALUE_IMPORT.lastIndex = 0;
    if (offender) {
      throw new Error(
        [
          `${path.relative(repositoryRoot, modulePath).split(path.sep).join("/")} imports CDK as a value:`,
          `  ${offender[0].trim()}`,
          'This catalog is loaded by CDK synthesis, the local dev servers and the invocation runner. Write "import type" so the import is erased.',
        ].join("\n"),
      );
    }
  }
}
