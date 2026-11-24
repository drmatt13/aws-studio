import type { ModeModel } from "./model";
import { gatewaysOf } from "./gateways";

/** A projection of the existing model, never a second application resource registry. */
export interface DevelopmentLogScope {
  readonly resourceId: string;
  readonly resourceIds: readonly string[];
  readonly routeId?: string;
  readonly kind: "captured" | "partial" | "unsupported" | "not-applicable";
  readonly reason?: string;
}

export function developmentLogScope(
  model: ModeModel,
  selected: string,
): DevelopmentLogScope | undefined {
  const result = (
    kind: DevelopmentLogScope["kind"],
    reason?: string,
    resourceIds: readonly string[] = [selected],
  ): DevelopmentLogScope => ({
    resourceId: selected,
    resourceIds,
    kind,
    ...(reason ? { reason } : {}),
  });
  const target = model.targets.find((item) => item.ref === selected);
  if (target) {
    if (
      target.role === "event" &&
      target.compute.kind === "lambda" &&
      !target.compute.localReplay
    ) {
      const localWorkflow = model.targets.some(
        (owner) =>
          owner.kind === "workflow" &&
          owner.lanes.local &&
          (model.workflows.some(
            (workflow) =>
              workflow.ref === owner.ref &&
              workflow.targets.includes(target.ref),
          ) ||
            model.edges.some(
              (edge) =>
                edge.relation === "step" &&
                edge.from === owner.ref &&
                edge.to === target.ref,
            )),
      );
      if (localWorkflow)
        return result(
          "partial",
          "Local workflow invocations are captured. AWS event-triggered executions are not collected; local replay is not enabled.",
        );
      return result(
        "unsupported",
        "This event handler runs in AWS during development. Local replay is not enabled; AWS execution is not collected here.",
      );
    }
    return target.lanes.local ||
      (target.role === "event" &&
        target.compute.kind === "lambda" &&
        target.compute.localReplay)
      ? result("captured")
      : result(
          "unsupported",
          "This workload has no enabled local execution lane. AWS logs are not collected.",
        );
  }
  const gateway = gatewaysOf(model).find((item) => item.id === selected);
  if (gateway) return result("captured");
  const route = model.routes.find((item) => item.id === selected);
  if (route) {
    const targetScope = developmentLogScope(model, route.target);
    return {
      resourceId: selected,
      resourceIds: [
        route.id,
        route.target,
        ...(route.kind === "agent"
          ? []
          : [
              route.kind === "webSocket" ? "gateway:websocket" : "gateway:http",
            ]),
      ],
      routeId: route.id,
      kind: targetScope?.kind ?? "unsupported",
      reason: targetScope?.reason,
    };
  }
  const local = model.localServices?.find((item) => item.id === selected);
  if (local)
    return result(
      "partial",
      "Local PostgreSQL lifecycle evidence only. SQL, statements, parameters and row values are omitted.",
    );
  const resource = model.resources.find((item) => item.id === selected);
  if (resource) {
    if (selected === model.managedDatabase?.resource)
      return result(
        "partial",
        "Development shows the local PostgreSQL counterpart's lifecycle evidence. SQL and row values are omitted.",
        [selected, ...(model.localServices ?? []).map((item) => item.id)],
      );
    if (
      ["input", "secret", "group", "envFile", "stack"].includes(
        resource.kind,
      ) ||
      (resource.kind === "member" &&
        (/^string$/.test(resource.typeText ?? "") ||
          /\bI?Secret\b/.test(resource.typeText ?? "")))
    )
      return result(
        "not-applicable",
        "This declaration has no local execution log stream.",
      );
    const observedIntegration = model.targets.some(
      (owner) =>
        owner.kind === "workflow" &&
        owner.lanes.local &&
        (model.workflows.some(
          (workflow) =>
            workflow.ref === owner.ref &&
            workflow.integrations.some(
              (integration) => integration.resource === selected,
            ),
        ) ||
          model.edges.some(
            (edge) =>
              edge.relation === "integration" &&
              edge.from === owner.ref &&
              edge.to === selected,
          )),
    );
    return observedIntegration
      ? result(
          "partial",
          "Only integration calls observed by the local framework can appear here. Service-internal AWS logs are not collected.",
        )
      : result(
          "unsupported",
          "This resource has no declared local capture point. Service-internal AWS logs are not collected.",
        );
  }
  if (
    selected.startsWith("island:") ||
    selected.startsWith("prop:vpc:") ||
    selected.startsWith("defaults:") ||
    selected.startsWith("schema:") ||
    selected.startsWith("schema-relation:") ||
    model.edges.some((item) => item.id === selected)
  )
    return result(
      "not-applicable",
      "This configuration or relationship has no independent local execution log stream.",
    );
  return undefined;
}
