import { displayName } from "./naming";
import type { DraftEdit } from "../shared/api";
import { resourceAccessDefinition, resourceAccessKey, type ResourceAccessDefinition } from "aws-studio/config/resource-access";
import { invocationAccessReason, invocationAccessWarning, nativeResourceAccessReason } from "../shared/workload-operations";
import type { ModelResource, ModelTarget, Snapshot } from "../shared/model";
import type { IconKey } from "./icons";
import type { ConfiguredResourceOption } from "./views/ConfiguredResourcePicker";

export type AccessConnectionEdit = Extract<DraftEdit, { kind: "connection" }>;
type AccessSnapshot = Pick<Snapshot, "models" | "source">;

export interface AccessAction {
  readonly id: string;
  readonly label: string;
  readonly edit: AccessConnectionEdit;
  readonly scope?: boolean;
  readonly variable?: boolean;
  readonly existing?: boolean;
  readonly reason?: string;
}

export interface ConfiguredAccessOption extends ConfiguredResourceOption {
  readonly actions: readonly AccessAction[];
  readonly definition?: ResourceAccessDefinition;
  readonly requireHttps?: boolean;
  readonly configuration?: boolean;
  readonly grants?: NonNullable<Snapshot["source"]["permissionCapabilities"]>[number]["grants"];
  readonly invokeTarget?: string;
}

const SERVICES: readonly { readonly type: RegExp; readonly subtitle: string; readonly icon: IconKey }[] = [
  { type: /^aws-s3:/, subtitle: "Amazon S3 · Bucket", icon: "bucket" },
  { type: /^aws-sqs:/, subtitle: "Amazon SQS · Queue", icon: "queue" },
  { type: /^aws-dynamodb:/, subtitle: "Amazon DynamoDB · Table", icon: "table" },
  { type: /^aws-sns:/, subtitle: "Amazon SNS · Topic", icon: "topic" },
  { type: /^aws-events:/, subtitle: "Amazon EventBridge · Event bus", icon: "bus" },
  { type: /^aws-cognito:/, subtitle: "Amazon Cognito", icon: "userpool" },
  { type: /^aws-secretsmanager:/, subtitle: "AWS Secrets Manager", icon: "secret" },
  { type: /^aws-rds:/, subtitle: "Amazon RDS", icon: "database" },
  { type: /^aws-lambda:/, subtitle: "AWS Lambda · Function", icon: "lambda" },
];

/** Match typed declaration facts across modes; presentation labels never establish a grant. */
export function accessConnectionExists(edit: AccessConnectionEdit, snapshot: AccessSnapshot): boolean {
  const models = Object.values(snapshot.models);
  const targets = models.flatMap(model => model.targets).filter(target => target.ref === edit.target);
  const edges = models.flatMap(model => model.edges).filter(edge => edge.from === edit.target);
  if (edit.connection === "database") return models.some(model => model.managedDatabase?.consumers?.some(consumer => consumer.target === edit.target)) || edges.some(edge => edge.relation === "database");
  if (edit.connection === "userPool") return targets.some(target => target.userPool);
  if (edit.connection === "resource") return !!edit.variable && targets.some(target =>
    target.environment.some(entry => entry.name === edit.variable && entry.value.kind === "reference" && entry.value.resource === edit.destination)
    || target.secrets.some(entry => entry.name === edit.variable && entry.resource === edit.destination));
  if (edit.connection === "grant") return edges.some(edge => edge.to === edit.destination && edge.relation === "grant"
    && edge.permissionContext?.kind === "native" && edge.permissionContext.method === edit.grant
    && (edit.grantArguments ? JSON.stringify(edge.permissionContext.arguments) === JSON.stringify(edit.grantArguments) : edit.scope ? edge.permissionContext.arguments.length === 1 && edge.permissionContext.arguments[0] === edit.scope : edge.permissionContext.arguments.length === 0));
  if (edit.connection === "managedPolicy") return edges.some(edge => edge.to === edit.destination && edge.permissionContext?.kind === "managedPolicy");
  if (edit.connection === "resourceAccess") {
    if (!edit.actions?.length) return false;
    try {
      const key = resourceAccessKey({ actions: edit.actions, limits: edit.limits });
      return edges.some(edge => edge.to === edit.destination && edge.permissionContext?.kind === "resourceAccess" && resourceAccessKey({ actions: edge.permissionContext.actions, limits: edge.permissionContext.limits }) === key);
    } catch { return false; } // Intermediate form text must remain editable.
  }
  const relation = edit.connection;
  return edges.some(edge => edge.to === edit.destination && edge.relation === relation);
}

/** A destination-first catalog. The source writer remains authoritative at review time. */
export function configuredAccessOptions(target: ModelTarget, snapshot: AccessSnapshot, destinationId?: string): ConfiguredAccessOption[] {
  if (target.kind === "workflow") return [];
  const models = Object.values(snapshot.models);
  const targets = new Map(models.flatMap(model => model.targets).map(item => [item.ref, item]));
  const resources = new Map<string, ModelResource>();
  for (const model of models) for (const resource of model.resources) {
    if (!resources.has(resource.id) || resources.get(resource.id)!.absent && !resource.absent) resources.set(resource.id, resource);
  }
  const capabilities = new Map<string, { readonly stack?: string; readonly canonicalTypes: readonly string[]; readonly category?: string; readonly requireHttps?: boolean; readonly reason?: string; readonly grants?: ConfiguredAccessOption["grants"] }>((snapshot.source.triggerCapabilities ?? []).map(item => [item.resource, item]));
  for (const item of snapshot.source.permissionCapabilities ?? []) capabilities.set(item.resource, { ...item, canonicalTypes: [...new Set([...(capabilities.get(item.resource)?.canonicalTypes ?? []), ...item.canonicalTypes])] });
  const action = (connection: AccessConnectionEdit["connection"], label: string, extra: Partial<AccessConnectionEdit> = {}, settings: Partial<AccessAction> = {}): AccessAction => {
    const edit: AccessConnectionEdit = { kind: "connection", target: target.ref, connection, enabled: true, ...extra };
    // Scoped grants and variable mappings can legitimately repeat with another scope/name.
    const existing = connection !== "resourceAccess" && !settings.scope && !settings.variable && accessConnectionExists(edit, snapshot);
    return { id: extra.grant ?? connection, label, edit, ...settings, ...(existing ? { existing: true, reason: "Already configured." } : {}) };
  };
  const result: ConfiguredAccessOption[] = [];
  const add = (option: ConfiguredAccessOption) => {
    const unavailable = option.actions.length > 0 && option.actions.every(action => action.reason);
    const next = { ...option, ...(unavailable && !option.reason ? { reason: option.actions.every(action => action.existing) ? "Already configured." : option.actions[0]!.reason } : {}) };
    const at = result.findIndex(item => item.id === option.id);
    if (at >= 0) result[at] = next; else result.push(next);
  };
  const owningStack = (resource: ModelResource): ModelResource | undefined => {
    const stackId = capabilities.get(resource.id)?.stack;
    if (stackId) return resources.get(stackId);
    const visited = new Set<string>();
    let current: ModelResource | undefined = resource;
    while (current && !visited.has(current.id)) {
      if (current.kind === "stack") return current;
      visited.add(current.id);
      current = current.parent ? resources.get(current.parent) : undefined;
    }
    return resources.get(`resource:${resource.path[0]}`);
  };

  const selectedResource = destinationId ? resources.get(destinationId) : undefined;
  const resourceSubtitle = (id: string, text: string) => {
    const available = Object.entries(snapshot.models).filter(([, model]) => model.resources.some(resource => resource.id === id && !resource.absent)).map(([mode]) => mode);
    return available.length === 1 ? `${text} · ${available[0] === "dev" ? "Development" : "Production"} only` : text;
  };
  for (const resource of destinationId ? selectedResource ? [selectedResource] : [] : resources.values()) {
    if (!/^resource:(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(resource.id)) continue;
    const title = displayName(snapshot.models.dev, resource.id, resource.path.join("."));
    const capability = capabilities.get(resource.id);
    const stack = owningStack(resource);
    const group = stack?.kind === "stack" && stack.id !== resource.id ? displayName(snapshot.models.dev, stack.id, stack.path.join(".")) : undefined;
    const warning = stack?.stackUsage?.status === "unreferenced" ? "This stack is not created in application.ts. Access can be declared; deployment needs the stack." : undefined;
    const descendants = resource.kind === "group" ? [...resources.values()].filter(item => item.id !== resource.id && item.path.length > resource.path.length && resource.path.every((part, index) => item.path[index] === part)) : [];
    if (resource.nativeKind === "value" || resource.kind === "group" && descendants.length > 0 && descendants.every(item => item.kind === "input" || item.kind === "group" || item.nativeKind === "value")) {
      add({ id: resource.id, title, subtitle: resource.kind === "group" ? "Input group" : "Configuration value", icon: "input", configuration: true, actions: [], reason: "This value is configuration. Edit its delivery under Configuration and inputs or in its declaration." });
      continue;
    }
    if (resource.kind === "input" || resource.kind === "secret" || capability?.category === "secret") {
      const secret = resource.kind === "secret" || capability?.category === "secret", startup = target.kind === "service" || target.kind === "task";
      add({ id: resource.id, title, subtitle: resourceSubtitle(resource.id, secret ? "AWS Secrets Manager · Secret" : "Input parameter"), icon: secret ? "secret" : "input",
        configuration: !secret, group, parent: group ? stack?.id : undefined, warning, reason: capability?.reason ?? (capability?.category === "secret" && !capability.stack ? "Expose this secret as a public stack field to use typed secret delivery." : undefined),
        searchTerms: `${resource.id} ${resource.path.join(".")} ${resource.fromEnv ?? ""} environment configuration ${secret ? "secrets" : "inputs"}`,
        actions: [action("resource", secret ? startup ? "Load secret at startup" : "Read secret" : "Use as environment variable", { destination: resource.id }, { variable: true })] });
      continue;
    }
    if (resource.kind !== "member" && resource.kind !== "construct") {
      const browsable = resource.kind === "stack" && [...resources.values()].some(item => (item.parent === resource.id || capabilities.get(item.id)?.stack === resource.id) && item.kind !== "input");
      add({ id: resource.id, title, subtitle: resource.kind === "stack" ? "CDK stack · Browse resources" : "Resource group", icon: resource.kind === "stack" ? "stack" : "group", ...(browsable ? { browseOnly: true, warning } : { reason: "Choose a resource inside this group." }), actions: [] });
      continue;
    }
    if (resource.frameworkManaged === "database") continue;
    const types = capabilities.get(resource.id)?.canonicalTypes ?? [];
    const service = SERVICES.find(service => types.some(type => service.type.test(type)));
    // The managed user-pool binding is offered once below, independent of its native fields.
    const definition = resourceAccessDefinition(types);
    const grants = capability?.grants;
    const policy = capability?.category === "policy";
    const reason = capability?.reason ?? (!definition && !policy && !grants?.some(grant => !grant.reason) ? "No supported grant method was discovered. Use a manual IAM rule or inspect its source." : undefined);
    const readiness = warning ?? nativeResourceAccessReason(target, resource.id, models);
    add({ id: resource.id, title, subtitle: resourceSubtitle(resource.id, service?.subtitle ?? resource.typeText ?? "Native CDK resource"), icon: service?.icon ?? "construct", group, parent: group ? stack?.id : undefined, warning: readiness, grants, searchTerms: `${resource.id} ${resource.path.join(".")} ${types.join(" ")} ${group ?? ""}`, reason,
      ...(definition ? { definition, requireHttps: capability?.requireHttps } : {}),
      actions: policy ? [action("managedPolicy", "Attach managed policy", { destination: resource.id })] : definition ? [action("resourceAccess", "Choose permissions", { destination: resource.id, actions: [] })] : (grants ?? []).map(grant => action("grant", grant.method, { destination: resource.id, grant: grant.method }, { reason: grant.reason })) });
  }

  const selectedTarget = destinationId ? targets.get(destinationId) : undefined;
  for (const destination of destinationId ? selectedTarget ? [selectedTarget] : [] : targets.values()) {
    if (destination.ref === target.ref) continue;
    const connection = destination.kind === "task" ? "runsTask" : destination.kind === "workflow" ? "startsWorkflow"
      : destination.kind === "agent" ? "invokesAgent" : undefined;
    if (!connection && destination.kind === "lambda") {
      add({ id: destination.ref, title: displayName(snapshot.models.dev, destination.ref, destination.title), subtitle: "AWS Lambda · Invoke permission", icon: "lambda", invokeTarget: destination.ref, searchTerms: `${destination.id} ${destination.ref} invoke`, actions: [] });
      continue;
    }
    if (!connection) {
      add({ id: destination.ref, title: displayName(snapshot.models.dev, destination.ref, destination.title), subtitle: destination.kind === "lambda" ? "AWS Lambda" : "Container service", icon: destination.kind, actions: [], reason: destination.role === "tool" ? "Select this tool through an AgentCore gateway." : destination.kind === "lambda" ? "General framework Lambda invocation is source-owned. Use its route, trigger, or workflow step." : "Configure this service’s HTTP interface and authentication." });
      continue;
    }
    const label = connection === "runsTask" ? "Run task" : connection === "startsWorkflow" ? "Start workflow" : connection === "invokesAgent" ? "Invoke agent" : "Use agent tool";
    const subtitle = connection === "runsTask" ? "AWS Fargate · Container task" : connection === "startsWorkflow" ? "AWS Step Functions · Workflow"
      : connection === "invokesAgent" ? "Amazon Bedrock AgentCore · Agent" : "AWS Lambda · Agent tool";
    add({ id: destination.ref, title: displayName(snapshot.models.dev, destination.ref, destination.title), subtitle, icon: destination.kind,
      searchTerms: `${destination.id} ${destination.ref} ${label}`, reason: invocationAccessReason(target, destination, models), warning: invocationAccessWarning(target, destination, models), actions: [action(connection, label, { destination: destination.ref })] });
  }

  const database = snapshot.models.prod.managedDatabase;
  if (database && target.kind !== "agent" && (!destinationId || destinationId === database.resource)) {
    const resource = resources.get(database.resource);
    const reason = target.role === "event" && target.compute.kind === "lambda" && !target.compute.localReplay
      ? "Enable local replay before connecting this event to the application database." : undefined;
    add({ id: database.resource, title: displayName(snapshot.models.dev, database.resource, resource?.path.join(".") ?? database.id), subtitle: "PostgreSQL · Application database", icon: "database",
      searchTerms: `${database.id} RDS database`, actions: [action("database", "Connect to database", {}, { reason })] });
  }
  if (!destinationId || destinationId === "framework:userPool") {
    const userPool = [...resources.values()].find(resource => (capabilities.get(resource.id)?.canonicalTypes ?? []).some(type => /^aws-cognito:I?UserPool$/.test(type)));
    const declaredPool = models.some(model => model.targets.some(item => item.userPool || item.environment.some(entry => entry.via === "userPool")));
    if ((userPool || declaredPool) && target.role !== "agent" && target.role !== "tool") {
      add({ id: "framework:userPool", title: "Application user pool", subtitle: "Amazon Cognito · User pool", icon: "userpool", searchTerms: "userPool identity user pool identifiers",
        configuration: true, actions: [action("userPool", "Use user-pool identifiers")] });
    }
  }
  const priority = (option: ConfiguredAccessOption) => option.configuration ? 2 : resources.get(option.id)?.kind === "secret" ? 1 : 0;
  return result.sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || priority(a) - priority(b) || (a.group ?? "").localeCompare(b.group ?? "") || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Permission choices exclude configuration and map-only items, retaining real blockers. */
export function permissionAccessOptions(target: ModelTarget, snapshot: AccessSnapshot, destinationId?: string): ConfiguredAccessOption[] {
  const options = configuredAccessOptions(target, snapshot, destinationId).filter(option => !option.configuration && (option.actions.length > 0 || option.invokeTarget || option.browseOnly));
  return options.filter(option => !option.browseOnly || options.some(child => child.parent === option.id && !child.browseOnly));
}
