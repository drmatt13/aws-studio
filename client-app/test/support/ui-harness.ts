import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** A throwaway DOM for exercising one hook. Each call owns its window and closes it in `cleanup`. */
export function setupDom() {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? dom.window : dom.window[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  const ui = require("@testing-library/react") as typeof import("@testing-library/react");
  return { act: ui.act, renderHook: ui.renderHook, cleanup: () => { ui.cleanup(); dom.window.close(); } };
}
