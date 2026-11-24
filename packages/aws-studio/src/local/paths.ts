export { normalizeProjectName, resolveProjectName } from "./project-name.mjs";

/** Authored development inputs (Compose mounts it); Compose consumes the exported root file. */
export const AUTHORED_ENV_FILE = "cdk-app/.env.dev";
export const OUTPUTS_ENV_FILE = ".env";
export const BASE_COMPOSE_FILE = "docker-compose.yml";

/**
 * Labels every container the task supervisor creates carries, and every image
 * the invocation runner builds: kind (task or lambda), project and target.
 *
 * Declared here rather than in the runner so runner shutdown can remove exactly what
 * the runner created. A task container is launched outside Compose, so nothing
 * else knows it belongs to this project; the same labels let the runner reclaim
 * images it built that no declared target uses any more.
 */
export const TASK_CONTAINER_KIND_LABEL = "com.matts-aws-framework.kind";
export const TASK_CONTAINER_PROJECT_LABEL = "com.matts-aws-framework.project";
export const TASK_CONTAINER_TARGET_LABEL = "com.matts-aws-framework.target";
export const TASK_CONTAINER_RUN_LABEL = "com.matts-aws-framework.run";
export const TASK_CONTAINER_RUNTIME_SESSION_LABEL = "com.matts-aws-framework.runtime-session";
/** Observation policy only; no input or secret value is stored in labels. */
export const TASK_CONTAINER_PRIVATE_OUTPUT_LABEL = "com.matts-aws-framework.private-output";
