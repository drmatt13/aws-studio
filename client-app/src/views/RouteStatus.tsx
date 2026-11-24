import { OwnershipStatus } from "./ResourceStatus";
import type { ModelRoute } from "../../shared/model";

/** A route is part of its workload's declaration, so it shares that workload's owner. */
export function RouteStatus({
  route,
  placement,
}: {
  readonly route: ModelRoute;
  readonly placement?: "header" | "inline";
}) {
  return <OwnershipStatus entity={route.id} {...(placement ? { placement } : {})} />;
}
