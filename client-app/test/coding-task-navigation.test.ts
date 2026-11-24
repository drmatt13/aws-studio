import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { CODING_PROMPT_LIMIT, OPEN_CODING_TASK_EVENT, PREPARE_CODING_TASK_EVENT, prepareCodingTask, type CodingTaskPreparation } from "../src/coding-task-navigation";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis; close(): void };

before(() => {
  const { JSDOM } = require("jsdom");
  const instance = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  dom = { window: instance.window, close: () => instance.window.close() };
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
});
after(() => dom.close());

test("preparing a Coding request opens only its prompt without accepting a task", () => {
  const prepared: CodingTaskPreparation[] = [];
  let accepted = 0;
  const receive = (event: Event) => prepared.push((event as CustomEvent<CodingTaskPreparation>).detail);
  const opened = () => { accepted++; };
  window.addEventListener(PREPARE_CODING_TASK_EVENT, receive);
  window.addEventListener(OPEN_CODING_TASK_EVENT, opened);
  try {
    const request = { id: "handoff-one", prompt: "Propagate Project.dueDate and check the changed files." };
    prepareCodingTask("/project", request);
    assert.deepEqual(prepared, [{ repository: "/project", request }]);
    assert.equal(accepted, 0);
    assert.equal(window.localStorage.length, 0, "editable request text stays in session memory");
  } finally {
    window.removeEventListener(PREPARE_CODING_TASK_EVENT, receive);
    window.removeEventListener(OPEN_CODING_TASK_EVENT, opened);
  }
});

test("an overlong prepared request is rejected in full instead of being truncated", () => {
  let prepared = 0;
  const receive = () => { prepared++; };
  window.addEventListener(PREPARE_CODING_TASK_EVENT, receive);
  try {
    assert.throws(() => prepareCodingTask("/project", { id: "large", prompt: "x".repeat(CODING_PROMPT_LIMIT + 1) }), /16,000/);
    assert.equal(prepared, 0);
  } finally { window.removeEventListener(PREPARE_CODING_TASK_EVENT, receive); }
});
