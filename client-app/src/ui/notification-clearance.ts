/** The gap between a floating dock and the edge beneath it. */
const DOCK_INSET = 12;

/** A ref for a floating control dock: notifications rest above it while it is mounted. */
export function reserveNotificationClearance(dock: HTMLElement | null) {
  const shell = dock?.closest<HTMLElement>('[data-ui="shell"]');
  if (!dock || !shell) return undefined;
  const measure = () => shell.style.setProperty("--notification-clearance", `${dock.offsetHeight + DOCK_INSET}px`);
  measure();
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
  observer?.observe(dock);
  return () => {
    observer?.disconnect();
    shell.style.removeProperty("--notification-clearance");
  };
}
