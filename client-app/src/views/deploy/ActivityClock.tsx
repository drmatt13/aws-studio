import { useEffect, useRef } from "react";
import { compactAge, formatDuration } from "./activity-model";

const readers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** One second-long timer for every clock on screen, and none when nothing is showing time. */
function everySecond(read: () => void) {
  readers.add(read);
  timer ??= setInterval(() => { for (const reader of readers) reader(); }, 1000);
  return () => {
    readers.delete(read);
    if (!readers.size && timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
}

/** Rewrites its own text only when that text changes, so time passing renders nothing. */
function Clock({ text, value }: { readonly text: (value: string) => string; readonly value: string }) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => everySecond(() => {
    const next = text(value);
    if (node.current && node.current.textContent !== next) node.current.textContent = next;
  }), [text, value]);
  return <span ref={node}>{text(value)}</span>;
}

const elapsedSince = (at: string) => formatDuration(Math.max(0, Date.now() - Date.parse(at)));

export const Elapsed = ({ since }: { readonly since: string }) => <Clock text={elapsedSince} value={since} />;
export const Age = ({ at }: { readonly at: string }) => <Clock text={compactAge as (value: string) => string} value={at} />;
