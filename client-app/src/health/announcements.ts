import { useEffect, useRef } from "react";
import type { HealthCondition } from "./conditions";

/** Long enough that a half-typed save, fixed moments later, never interrupts anyone. */
export const HEALTH_SETTLE_MS = 1200;

export interface HealthAnnouncement {
  /** Keys the toast, so a recovery replaces the failure it answers. */
  readonly condition: HealthCondition["id"];
  readonly text: string;
  readonly tone: "plain" | "accept" | "refuse";
  readonly opensHealth: boolean;
}

/** Toasts report conditions starting and ending. A condition's changing details are the indicator's job. */
export function healthAnnouncements(previous: readonly HealthCondition[], next: readonly HealthCondition[]): readonly HealthAnnouncement[] {
  const before = new Set(previous.map((condition) => condition.id));
  const after = new Set(next.map((condition) => condition.id));
  return [
    ...next.filter((condition) => !before.has(condition.id) && condition.raised).map((condition): HealthAnnouncement => (
      { condition: condition.id, text: condition.raised!, tone: condition.severity === "error" ? "refuse" : "plain", opensHealth: true })),
    ...previous.filter((condition) => !after.has(condition.id) && condition.recovered).map((condition): HealthAnnouncement => (
      { condition: condition.id, text: condition.recovered!, tone: "accept", opensHealth: false })),
  ];
}

/**
 * Compares settled states, so a burst of snapshots is one transition, a failure
 * gone before it settles is none, and opening Studio on a known problem is none.
 * `quiet` records a transition without toasting it: an open panel already shows it.
 */
export function useHealthAnnouncements(conditions: readonly HealthCondition[], announce: (item: HealthAnnouncement) => void, quiet: boolean): void {
  const settled = useRef(conditions);
  const latest = useRef({ conditions, quiet });
  useEffect(() => { latest.current = { conditions, quiet }; });
  const active = conditions.map((condition) => condition.id).join(" ");
  useEffect(() => {
    const timer = setTimeout(() => {
      const { conditions: current, quiet: silenced } = latest.current;
      const transitions = healthAnnouncements(settled.current, current);
      settled.current = current;
      if (!silenced) transitions.forEach(announce);
    }, HEALTH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [active, announce]);
}
