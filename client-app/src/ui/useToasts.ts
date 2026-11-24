import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "plain" | "accept" | "refuse";
export interface ToastAction { readonly label: string; readonly run: () => void }
export interface ToastOptions {
  readonly action?: ToastAction;
  /** Names what this notification is about. A newer one with the same key replaces it where it stands. */
  readonly key?: string;
}
export interface Toast extends ToastOptions { readonly id: number; readonly text: string; readonly tone: ToastTone }

const VISIBLE_LIMIT = 4;
const ROUTINE_MS = 6000;
const REFUSAL_MS = 9000;

/**
 * The one notification list. A repeat restarts what is showing, so a retry loop
 * cannot pile up, and a keyed update replaces its predecessor, so a failure and
 * its recovery are never on screen together.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const visible = useRef<readonly Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);
  const publish = useCallback((next: readonly Toast[]) => {
    visible.current = next;
    setToasts(next);
  }, []);
  const forget = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);
  const dismissToast = useCallback((id: number) => {
    forget(id);
    publish(visible.current.filter((item) => item.id !== id));
  }, [forget, publish]);
  const toast = useCallback((text: string, tone: ToastTone = "plain", { action, key }: ToastOptions = {}) => {
    const known = visible.current.find((item) => key === undefined
      ? item.key === undefined && item.text === text && item.tone === tone
      : item.key === key);
    const entry: Toast = { id: known?.id ?? nextId.current++, text, tone, ...(action ? { action } : {}), ...(key === undefined ? {} : { key }) };
    if (known) publish(visible.current.map((item) => item.id === known.id ? entry : item));
    else {
      const listed = [...visible.current, entry];
      listed.slice(0, -VISIBLE_LIMIT).forEach((item) => forget(item.id));
      publish(listed.slice(-VISIBLE_LIMIT));
    }
    forget(entry.id);
    timers.current.set(entry.id, setTimeout(() => dismissToast(entry.id), tone === "refuse" ? REFUSAL_MS : ROUTINE_MS));
  }, [dismissToast, forget, publish]);
  useEffect(() => {
    const running = timers.current;
    return () => running.forEach((timer) => clearTimeout(timer));
  }, []);
  return { toasts, toast, dismissToast };
}
