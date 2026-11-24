import { randomUUID } from "node:crypto";
import {
  newDevelopmentCorrelation,
  sanitizeDevelopmentCorrelation,
  type DevelopmentCorrelation,
} from "aws-studio/development-logs";

/** Local tracing metadata conveys evidence identity, never caller authority. */
export const DEVELOPMENT_OBSERVATION_HEADER =
  "x-framework-development-observation";
export function readDevelopmentCorrelation(
  value: unknown,
): DevelopmentCorrelation {
  if (typeof value !== "string" || value.length > 2048) return {};
  try {
    return sanitizeDevelopmentCorrelation(JSON.parse(value));
  } catch {
    return {};
  }
}

/** Transport hops continue one logical invocation; internal calls create a child. */
export function containerLambdaCorrelation(
  intended?: DevelopmentCorrelation,
): DevelopmentCorrelation {
  if (intended?.traceId && intended.spanId && intended.invocationId)
    return intended;
  return newDevelopmentCorrelation({ invocationId: randomUUID() });
}
