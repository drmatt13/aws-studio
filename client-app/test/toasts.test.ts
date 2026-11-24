import assert from "./support/assert";
import test, { mock } from "node:test";
import { useToasts } from "../src/ui/useToasts";
import { setupDom } from "./support/ui-harness";

function harness() {
  const dom = setupDom();
  mock.timers.enable({ apis: ["setTimeout"] });
  const view = dom.renderHook(() => useToasts());
  return { view, act: dom.act, wait: (ms: number) => dom.act(() => mock.timers.tick(ms)), done: () => { view.unmount(); mock.timers.reset(); dom.cleanup(); } };
}

test("an identical notification restarts the visible one instead of stacking", () => {
  const h = harness();
  h.act(() => h.view.result.current.toast("Reload failed", "refuse"));
  h.wait(8000);
  h.act(() => h.view.result.current.toast("Reload failed", "refuse"));
  assert.equal(h.view.result.current.toasts.length, 1);
  h.wait(8000);
  assert.equal(h.view.result.current.toasts.length, 1, "the repeat restarted the timer");
  h.wait(1000);
  assert.equal(h.view.result.current.toasts.length, 0);
  h.done();
});

test("the same words at another tone are a different notification", () => {
  const h = harness();
  h.act(() => { h.view.result.current.toast("Done", "plain"); h.view.result.current.toast("Done", "refuse"); });
  assert.equal(h.view.result.current.toasts.length, 2);
  h.done();
});

test("refusals stay longer than routine notes", () => {
  const h = harness();
  h.act(() => { h.view.result.current.toast("note"); h.view.result.current.toast("refusal", "refuse"); });
  h.wait(6000);
  assert.deepEqual(h.view.result.current.toasts.map(item => item.text), ["refusal"]);
  h.wait(3000);
  assert.deepEqual(h.view.result.current.toasts, []);
  h.done();
});

test("at most four remain, keeping the newest", () => {
  const h = harness();
  h.act(() => { for (const text of ["a", "b", "c", "d", "e"]) h.view.result.current.toast(text); });
  assert.deepEqual(h.view.result.current.toasts.map(item => item.text), ["b", "c", "d", "e"]);
  h.done();
});

test("dismissing removes one and an evicted toast's timer cannot remove a successor", () => {
  const h = harness();
  h.act(() => { for (const text of ["a", "b"]) h.view.result.current.toast(text); });
  h.act(() => h.view.result.current.dismissToast(h.view.result.current.toasts[0]!.id));
  assert.deepEqual(h.view.result.current.toasts.map(item => item.text), ["b"]);
  h.done();
});

test("an action travels with its notification", () => {
  const h = harness();
  let opened = 0;
  h.act(() => h.view.result.current.toast("Broke", "refuse", { action: { label: "Show details", run: () => { opened += 1; } } }));
  h.view.result.current.toasts[0]!.action!.run();
  assert.equal(opened, 1);
  h.done();
});

test("a keyed notification replaces its predecessor where it stands, so the two never contradict", () => {
  const h = harness();
  h.act(() => { h.view.result.current.toast("Above", "plain"); h.view.result.current.toast("It broke", "refuse", { key: "subject" }); h.view.result.current.toast("Below", "plain"); });
  const { id } = h.view.result.current.toasts[1]!;
  h.act(() => h.view.result.current.toast("It works again", "accept", { key: "subject" }));
  assert.deepEqual(h.view.result.current.toasts.map(item => item.text), ["Above", "It works again", "Below"]);
  assert.equal(h.view.result.current.toasts[1]!.id, id, "the same element changes, so nothing around it moves");
  assert.equal(h.view.result.current.toasts[1]!.tone, "accept");
  h.done();
});

test("a replacement takes on its own duration and drops the action it no longer offers", () => {
  const h = harness();
  h.act(() => h.view.result.current.toast("It broke", "refuse", { key: "subject", action: { label: "Show details", run: () => undefined } }));
  h.act(() => h.view.result.current.toast("It works again", "accept", { key: "subject" }));
  assert.equal(h.view.result.current.toasts[0]!.action, undefined);
  h.wait(6000);
  assert.deepEqual(h.view.result.current.toasts, [], "the refusal's longer timer did not carry over");
  h.done();
});

test("a key never matches a notification without one", () => {
  const h = harness();
  h.act(() => { h.view.result.current.toast("Same words", "plain"); h.view.result.current.toast("Same words", "plain", { key: "subject" }); });
  assert.equal(h.view.result.current.toasts.length, 2);
  h.done();
});
