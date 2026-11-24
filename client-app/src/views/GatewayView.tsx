import { AgentCoreGatewayView } from "./AgentCoreGatewayView";
import {
  inspectorHeaderClasses,
  inspectorRelationListClasses,
} from "../inspector-ui";
import { targetIcon } from "../icons";
import { EntityIcon } from "./EntityIcon";
import { EntityName } from "./EntityName";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";

import type { ModelGateway } from "../../shared/gateways";
import { useStudio } from "../studio";
import { DeploymentOwnership, useHoverEnvironments } from "./Deployment";
import { Description } from "./Description";
import { Tags } from "./Tags";
import { InspectorDisclosure, InspectorKind, InspectorResourceRow } from "./InspectorUI";
import { OwnershipStatus } from "./ResourceStatus";
import { Ownership } from "./Ownership";
import { ResourceLogs } from "./ResourceLogs";
import { StackExports } from "./StackExports";
import { Written } from "./Written";

export function GatewayView({ gateway }: { readonly gateway: ModelGateway }) {
  if (gateway.protocol === "agentcore") return <AgentCoreGatewayView gateway={gateway} />;
  return <ApiGatewayView gateway={gateway} />;
}

function ApiGatewayView({ gateway }: { readonly gateway: Exclude<ModelGateway, { protocol: "agentcore" }> }) {
  const { model, select } = useStudio();
  const routes = model.routes.filter((route) => gateway.routes.includes(route.id));
  const stack = model.resources.find((resource) => resource.id === gateway.stackResource);
  const handler = (ref: string) => model.targets.find((target) => target.ref === ref);
  const authorizer = gateway.authorizer ? handler(gateway.authorizer) : undefined;
  const environments = useHoverEnvironments("gateway", gateway.id);
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind
          environments={{
            ...environments,
            note: "The framework manages this gateway. Configure Deploy on its handlers to control where they run.",
            details: <DeploymentOwnership owners={[...new Set(routes.map(route => route.target))].map(ref => ({
              id: ref, title: model.targets.find(target => target.ref === ref)?.title ?? ref,
            }))} />,
          }}
        >
          Amazon API Gateway
        </InspectorKind>
        <EntityName
          entity={gateway.id}
          fallback={gateway.title}
          icon="gateway"
        />
        <OwnershipStatus entity={gateway.id} />
        <Written
          placement="header"
          location={stack?.stackOutputs?.[0]?.source}
          label="Defined in"
        />
      </header>
      <Description entity={gateway.id} />
      <Tags entity={gateway.stackResource} />
      <Ownership entity={gateway.id} />
      <ResourceLogs selected={gateway.id} />
      <InspectorDisclosure title="Routes" count={routes.length}>
        {/* Like every resource row, a route is titled by the handler its artwork depicts; the
            path it answers is the metadata beneath and still opens the route. */}
        <ul className={inspectorRelationListClasses} data-slot="relations">
          {routes.map((route) => {
            const target = handler(route.target);
            return (
              <InspectorResourceRow
                key={route.id}
                data-slot="gateway-route"
                icon={<EntityIcon size={26} icon={target ? targetIcon(target) : "lambda"} />}
                title={
                  <button
                    className={buttonClasses({ variant: "link" })}
                    onClick={() => select(route.target)}
                  >
                    {target?.id ?? route.target}
                  </button>
                }
              >
                <span>
                  <button
                    className={cx(buttonClasses({ variant: "link" }), "font-mono text-[.86em]")}
                    onClick={() => select(route.id)}
                  >
                    {route.methods === "*"
                      ? "ANY "
                      : route.methods
                        ? `${route.methods.join(", ")} `
                        : ""}
                    {route.browserPath ?? route.path}
                  </button>{" "}
                  · {route.auth ? "Authenticated" : "Public"}
                </span>
              </InspectorResourceRow>
            );
          })}
        </ul>
      </InspectorDisclosure>
      {gateway.authorizer ? (
        <InspectorDisclosure title="Connection authorizer">
          <ul className={inspectorRelationListClasses}>
            <InspectorResourceRow
              data-slot="gateway-authorizer"
              icon={<EntityIcon size={26} icon={authorizer ? targetIcon(authorizer) : "lambda"} />}
              title={
                <button
                  className={buttonClasses({ variant: "link" })}
                  onClick={() => select(gateway.authorizer)}
                >
                  {authorizer?.id ?? gateway.authorizer}
                </button>
              }
            >
              <span>Guards the $connect handshake wherever these routes are enabled.</span>
            </InspectorResourceRow>
          </ul>
        </InspectorDisclosure>
      ) : null}
      {stack ? <StackExports stack={stack} /> : null}
    </>
  );
}
