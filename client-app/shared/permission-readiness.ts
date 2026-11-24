import type { DeploymentReadinessIssue, ModeModel, ModelResource, SourceIndex } from "./model";
import { invocationAccessWarning } from "./workload-operations";

/** Source validity and deployment readiness are independent. Never turn these into load errors. */
export function withPermissionReadiness(model: ModeModel, source?: SourceIndex): ModeModel {
  const resources = new Map(model.resources.map(resource => [resource.id, resource]));
  const targets = new Map(model.targets.map(target => [target.ref, target]));
  const issues: DeploymentReadinessIssue[] = [];
  const owningStack = (resource: ModelResource): ModelResource | undefined => {
    const seen = new Set<string>();
    let current: ModelResource | undefined = resource;
    while (current && !seen.has(current.id)) {
      if (current.kind === "stack") return current;
      seen.add(current.id);
      current = current.parent ? resources.get(current.parent) : undefined;
    }
    return resources.get(`resource:${resource.path[0]}`)?.kind === "stack" ? resources.get(`resource:${resource.path[0]}`) : undefined;
  };
  for (const resource of model.resources) {
    if (resource.kind === "stack" && resource.stackUsage?.status === "unknown") issues.push({
      code: "construction-unknown", severity: "warning", entity: resource.id,
      message: `Construction of ${resource.stackClass ?? resource.path.join(".")} could not be verified. Inspect cdk-app/lib/application.ts and its imports.`,
      blocksDeployment: false, source: source?.entities[resource.id]?.value,
    });
  }
  const edges = model.edges.map(edge => {
    const { readinessIssues: _previous, ...current } = edge;
    const caller = targets.get(edge.from);
    // The development AWS function only captures replay events. Its handler uses local PostgreSQL.
    if (model.mode === "dev" && edge.relation === "database" && caller?.lanes.local && caller.compute.kind === "lambda" && caller.compute.localReplay) return current;
    const deployed = !!caller?.lanes[model.mode];
    const destination = targets.get(edge.to);
    const invocationWarning = caller && destination && ["runsTask", "startsWorkflow", "invokesAgent"].includes(edge.relation)
      ? invocationAccessWarning(caller, destination, [model]) : undefined;
    if (invocationWarning) {
      const issue: DeploymentReadinessIssue = {
        code: "resource-unavailable", severity: "error", entity: edge.id, related: [edge.from, edge.to],
        message: invocationWarning, blocksDeployment: deployed, source: source?.entities[edge.to]?.value,
      };
      issues.push(issue);
      return { ...current, readinessIssues: [issue] };
    }
    const arnTarget = (edge.permissionContext?.kind === "iamPolicy" || ["runsTask", "startsWorkflow", "invokesAgent", "step", "usesTool"].includes(edge.relation)) && targets.get(edge.to);
    if (arnTarget && deployed && !arnTarget.lanes[model.mode]) {
      const issue: DeploymentReadinessIssue = {
        code: "resource-unavailable", severity: "error", entity: edge.id, related: [edge.from, edge.to],
        message: `${arnTarget.title} is not built in the caller's ${model.mode === "dev" ? "development" : "production"} AWS lane. This declared connection is saved. ${model.mode === "dev" ? "Development AWS builds event functions; use a local caller for development, or deploy this connection in production." : "Enable the referenced workload before deploying its caller."}`,
        blocksDeployment: true, source: source?.entities[edge.to]?.value,
      };
      issues.push(issue);
      return { ...current, readinessIssues: [issue] };
    }
    if (!edge.to.startsWith("resource:") || edge.relation === "contains" || edge.provenance === "source") return current;
    const resource = resources.get(edge.to);
    if (!resource) return current;
    const stack = owningStack(resource);
    let issue: DeploymentReadinessIssue | undefined;
    if (stack?.stackUsage?.status === "unreferenced") issue = {
      code: "stack-not-constructed", severity: "error", entity: edge.id,
      related: [edge.from, edge.to, stack.id],
      message: `${resource.path.join(".")} is declared, but ${stack.stackClass ?? stack.path.join(".")} is not created in cdk-app/lib/application.ts. This connection is saved; construct and link the stack before deploying its caller.`,
      blocksDeployment: deployed, source: source?.entities[stack.id]?.value,
    };
    else if (stack?.stackUsage?.status === "unknown") issue = {
      code: "construction-unknown", severity: "warning", entity: edge.id, related: [edge.from, edge.to, stack.id],
      message: `Construction of ${stack.stackClass ?? stack.path.join(".")} could not be verified. Check its construction and link before deploying access to ${resource.path.join(".")}.`,
      blocksDeployment: false, source: source?.entities[stack.id]?.value,
    };
    else if (resource.absent && deployed) issue = {
      code: "resource-unavailable", severity: "error", entity: edge.id, related: [edge.from, edge.to],
      message: `${resource.path.join(".")} is unavailable in the caller's ${model.mode === "dev" ? "development" : "production"} AWS lane. Align the declarations before deployment.`,
      blocksDeployment: true, source: source?.entities[resource.id]?.value,
    };
    else if (source?.linkAnalysis && (resource.kind === "construct" || resource.kind === "member" && stack)) {
      const catalogPath = resource.path.join(".");
      const groupPath = stack?.path.join(".");
      const linked = !!source.links[catalogPath]?.length || !!groupPath && source.linkAnalysis.groups.includes(groupPath);
      if (!linked) {
        const uncertain = source.linkAnalysis.unknown.find(item => {
          if (item.path) return item.path === catalogPath || catalogPath.startsWith(`${item.path}.`) || item.path.startsWith(`${catalogPath}.`);
          // An unresolved constructor parameter is local evidence for that stack;
          // an unowned generic helper can affect any native catalog reference.
          const owners = item.source && Object.entries(source.catalog).filter(([, entry]) => entry.stackLocation?.file === item.source!.file);
          return !owners?.length || owners.some(([id]) => id === stack?.id);
        });
        const related = [edge.from, edge.to, ...(stack ? [stack.id] : [])];
        issue = uncertain || !source.linkAnalysis.complete ? {
          code: "link-unknown", severity: "warning", entity: edge.id, related,
          message: `Native linking of stacks.${catalogPath} could not be verified. ${uncertain?.reason ?? "Part of application CDK could not be analyzed."} Inspect its linkResource/linkResources call before deployment; this connection is saved.`,
          blocksDeployment: false, source: uncertain?.source ?? source.entities[resource.id]?.value,
        } : {
          code: "resource-not-linked", severity: "error", entity: edge.id, related,
          message: `No direct native link was found for stacks.${catalogPath}. Call linkResource for this resource${stack ? ` or linkResources for stacks.${groupPath}` : ""} beside its native definition before deploying its caller. This connection is saved.`,
          blocksDeployment: deployed, source: source.entities[resource.id]?.value,
        };
      }
    }
    if (!issue) return current;
    issues.push(issue);
    return { ...current, readinessIssues: [issue] };
  });
  const forEntity = (entity: string) => issues.filter(issue => issue.entity === entity || issue.related?.includes(entity));
  return { ...model, edges, readinessIssues: issues,
    targets: model.targets.map(({ readinessIssues: _previous, ...target }) => ({ ...target, readinessIssues: forEntity(target.ref) })),
    resources: model.resources.map(({ readinessIssues: _previous, ...resource }) => ({ ...resource, readinessIssues: forEntity(resource.id) })),
  };
}
