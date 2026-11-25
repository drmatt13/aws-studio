import { RELEASE_COMPOSE_FILE } from "aws-studio/compose-services";
import { DEPLOYMENT_SETTING_KEYS } from "aws-studio/config/project-declarations";
import { CDK_ENVIRONMENT_ID, FRAMEWORK_INPUT_GROUPS } from "../../shared/deployment-inputs";
import { gatewaysOf } from "../../shared/gateways";
import type { ModeModel, OwnershipFacts } from "../../shared/model";
import type { InputMetadata } from "../evaluator/input-metadata";

/** Studio owns these framework identities. Project snapshots contribute the installed source,
 * declared settings and enabled integrations that actually exist in that project. */
const STARTER_STACKS: Readonly<Record<string, string>> = {
  FrontendWebsiteS3Stack: "cdk-app/lib/app/frontend-website-s3-stack.ts",
  RdsStack: "cdk-app/lib/app/rds-stack.ts",
};

const LOCAL_SETTINGS = new Set([
  "localAwsProfile", "localAwsRegion", "localTestUserEmail", "localTestUserPassword",
  "localInvocationRunnerHostPort", "postgresHostPort", "pgadminHostPort",
  "localLambdaWarm", "localLambdaWarmMax", "localLambdaWarmIdleSeconds",
]);
const DEPLOYMENT_SETTINGS = new Set<string>(DEPLOYMENT_SETTING_KEYS);

export function frameworkResourceOwnership(
  model: ModeModel,
  declarations: Readonly<Record<string, OwnershipFacts>>,
  metadata?: InputMetadata,
): Record<string, OwnershipFacts> {
  const records = { ...declarations };
  function register(id: string, note: string, projectDeclaration = false): void {
    const authored = declarations[id];
    if (projectDeclaration && authored?.basis === "declared") {
      records[id] = { ...authored, projectOverride: true };
    } else {
      records[id] = { managedBy: "framework", basis: "catalog", note, ...(projectDeclaration ? { projectOverride: true } : {}) };
    }
  }

  for (const gateway of gatewaysOf(model)) {
    if (gateway.protocol !== "agentcore") register(gateway.id, `AWS Studio builds the ${gateway.title} from the project's routes.`);
  }
  if (model.managedDatabase) {
    register(`database:${model.managedDatabase.id}`, "AWS Studio provides the primary PostgreSQL database integration. The project configures it through defineDatabase().", true);
  }
  for (const service of model.localServices ?? []) {
    if (service.source?.file === RELEASE_COMPOSE_FILE) register(service.id, `The installed AWS Studio release defines this service in ${RELEASE_COMPOSE_FILE}.`);
  }
  const providerInputs = new Set(metadata?.signIn.flatMap(provider => provider.keys.map(key => `${FRAMEWORK_INPUT_GROUPS.authentication.id}.${key}`)));
  for (const resource of model.resources) {
    const { id, stackClass, stackFile, frameworkInput } = resource;
    if (resource.kind === "stack" && stackClass && stackFile) {
      if (stackFile.startsWith("node_modules/aws-studio/cdk/")) {
        register(id, `The installed AWS Studio release defines ${stackClass} in ${stackFile}.`);
      } else if (STARTER_STACKS[stackClass] === stackFile && (resource.frameworkStack || declarations[id])) {
        register(id, `The AWS Studio starter defines ${stackClass} in ${stackFile}.`, !resource.frameworkStack);
      }
    } else if (id === CDK_ENVIRONMENT_ID && resource.deploymentFiles) {
      register(id, "AWS Studio combines the project's development and production input files in the CDK environment editor.");
    } else if (frameworkInput && resource.kind === "group" && id === FRAMEWORK_INPUT_GROUPS[frameworkInput].id
      && (frameworkInput !== "authentication" || providerInputs.size > 0)) {
      register(id, `AWS Studio groups the settings read by ${FRAMEWORK_INPUT_GROUPS[frameworkInput].reader}.`);
    } else if (frameworkInput && (resource.kind === "input" || resource.kind === "secret")) {
      const group = FRAMEWORK_INPUT_GROUPS[frameworkInput];
      const key = id.slice(group.id.length + 1);
      const known = id.startsWith(group.id + ".") && (frameworkInput === "deployment" && DEPLOYMENT_SETTINGS.has(key)
        || frameworkInput === "local" && LOCAL_SETTINGS.has(key) || frameworkInput === "authentication" && providerInputs.has(id));
      if (known && declarations[id]) register(id, `AWS Studio defines this setting for ${group.reader}.`, true);
    }
  }
  return records;
}
