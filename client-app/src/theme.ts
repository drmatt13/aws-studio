import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";
const storageKey = "aws-studio-theme";
const changeEvent = "studio-theme-change";
const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

/** Apply the saved preference before React mounts; otherwise CSS follows the OS. */
export function initializeStudioTheme() {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (isTheme(saved)) document.documentElement.dataset.theme = saved;
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
}

function currentTheme(): Theme {
  const selected = document.documentElement.dataset.theme;
  if (isTheme(selected)) return selected;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(change: () => void) {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const syncStorage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    if (isTheme(event.newValue)) document.documentElement.dataset.theme = event.newValue;
    else delete document.documentElement.dataset.theme;
    change();
  };
  media?.addEventListener?.("change", change);
  window.addEventListener(changeEvent, change);
  window.addEventListener("storage", syncStorage);
  return () => {
    media?.removeEventListener?.("change", change);
    window.removeEventListener(changeEvent, change);
    window.removeEventListener("storage", syncStorage);
  };
}

export function toggleStudioTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    window.localStorage.setItem(storageKey, next);
  } catch {
    // The document preference does not depend on persistence.
  }
  window.dispatchEvent(new window.Event(changeEvent));
}

export function useStudioTheme() {
  return useSyncExternalStore(subscribe, currentTheme, () => "light" as const);
}
