/**
 * Repository-relative implementation paths. Kept independent of generated
 * target IDs so generation can discover sources before loading configuration.
 */
export const COMPUTE_SOURCE_ROOT = "compute";
export const HTTP_SOURCE_ROOT = `${COMPUTE_SOURCE_ROOT}/http` as const;
export const WEBSOCKET_SOURCE_ROOT = `${COMPUTE_SOURCE_ROOT}/websocket` as const;
export const EVENT_SOURCE_ROOT = `${COMPUTE_SOURCE_ROOT}/events` as const;
export const TOOL_SOURCE_ROOT = `${COMPUTE_SOURCE_ROOT}/tools` as const;
export const SERVICE_SOURCE_ROOT = `${COMPUTE_SOURCE_ROOT}/services` as const;
export const TASK_SOURCE_ROOT = `${COMPUTE_SOURCE_ROOT}/tasks` as const;
export const AGENT_SOURCE_ROOT = `${COMPUTE_SOURCE_ROOT}/agents` as const;

/** Default destinations used by declarations, generators and Studio starters. */
export const COMPUTE_SOURCE_ROOTS = {
  http: HTTP_SOURCE_ROOT, webSocket: WEBSOCKET_SOURCE_ROOT, event: EVENT_SOURCE_ROOT,
  tool: TOOL_SOURCE_ROOT, service: SERVICE_SOURCE_ROOT, task: TASK_SOURCE_ROOT, agent: AGENT_SOURCE_ROOT,
} as const;
export function defaultComputeDirectory(kind: keyof typeof COMPUTE_SOURCE_ROOTS, id: string): `compute/${string}` {
  return `${COMPUTE_SOURCE_ROOTS[kind]}/${id}`;
}

/** Conventional Lambda trees; services, tasks and agents are never Lambda inventory. */
export const LAMBDA_SOURCE_ROOTS = [
  HTTP_SOURCE_ROOT,
  WEBSOCKET_SOURCE_ROOT,
  EVENT_SOURCE_ROOT,
  TOOL_SOURCE_ROOT,
] as const;

/** The common containment boundary of every compute implementation. */
export const LAMBDA_SOURCE_ROOT = COMPUTE_SOURCE_ROOT;
