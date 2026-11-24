import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { HealthIndicator } from "./conditions";

/** Severity changes the shape as well as the colour, so it never relies on colour alone. */
export const SEVERITY_ICON: Readonly<Record<HealthIndicator["severity"], LucideIcon>> = {
  healthy: CircleCheck, notice: Info, warning: TriangleAlert, error: CircleAlert,
};
