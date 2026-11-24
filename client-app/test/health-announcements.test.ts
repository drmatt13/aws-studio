import assert from "./support/assert";
import test, { mock } from "node:test";
import { healthAnnouncements, HEALTH_SETTLE_MS, useHealthAnnouncements, type HealthAnnouncement } from "../src/health/announcements";
import type { HealthCondition } from "../src/health/conditions";
import { setupDom } from "./support/ui-harness";

const condition = (id: HealthCondition["id"], overrides: Partial<HealthCondition> = {}) => ({
  id, severity: "error", title: id, explanation: "", label: id, showsLastLoaded: false, findings: [], capabilities: [], askAgent: false,
  raised: `${id} raised`, recovered: `${id} recovered`, ...overrides,
} as HealthCondition);
const broken = condition("configuration");

test("a new failure announces once, as a refusal that can open the details", () => {
  assert.deepEqual(healthAnnouncements([], [broken]), [{ condition: "configuration", text: "configuration raised", tone: "refuse", opensHealth: true }]);
});

test("a warning is announced without alarm", () => {
  const [announcement] = healthAnnouncements([], [condition("source-watch", { severity: "warning" })]);
  assert.equal(announcement?.tone, "plain");
});

test("recovery confirms what came back", () => {
  assert.deepEqual(healthAnnouncements([broken], []), [{ condition: "configuration", text: "configuration recovered", tone: "accept", opensHealth: false }]);
});

test("the same condition with different evidence stays silent: the indicator updates in place", () => {
  assert.deepEqual(healthAnnouncements([broken], [condition("configuration", { raised: "another file" })]), []);
});

test("a condition with nothing to say raises no toast in either direction", () => {
  const notes = condition("notes", { severity: "notice", raised: undefined, recovered: undefined });
  assert.deepEqual(healthAnnouncements([], [notes]), []);
  assert.deepEqual(healthAnnouncements([notes], []), []);
});

test("a different condition resolving and arising are each announced", () => {
  const watch = condition("source-watch", { severity: "warning" });
  assert.deepEqual(healthAnnouncements([broken], [watch]).map(item => item.text), ["source-watch raised", "configuration recovered"]);
});

/** The hook's timing contract, driven with mocked timers. */
function harness(initial: readonly HealthCondition[], paused = false) {
  const dom = setupDom();
  mock.timers.enable({ apis: ["setTimeout"] });
  const heard: HealthAnnouncement[] = [];
  const announce = (item: HealthAnnouncement) => heard.push(item);
  const view = dom.renderHook(({ conditions, quiet }: { conditions: readonly HealthCondition[]; quiet: boolean }) => useHealthAnnouncements(conditions, announce, quiet), { initialProps: { conditions: initial, quiet: paused } });
  return { heard, set: (conditions: readonly HealthCondition[], quiet = paused) => view.rerender({ conditions, quiet }), wait: (ms: number) => dom.act(() => mock.timers.tick(ms)), done: () => { view.unmount(); mock.timers.reset(); dom.cleanup(); } };
}

test("a problem already present when Studio opens is not a transition", () => {
  const h = harness([broken]);
  h.wait(HEALTH_SETTLE_MS * 2);
  assert.deepEqual(h.heard, []);
  h.done();
});

test("a failure is announced only after it settles", () => {
  const h = harness([]);
  h.set([broken]);
  h.wait(HEALTH_SETTLE_MS - 1);
  assert.deepEqual(h.heard, []);
  h.wait(1);
  assert.equal(h.heard.length, 1);
  h.done();
});

test("a failure that resolves before settling is never announced in either direction", () => {
  const h = harness([]);
  h.set([broken]);
  h.wait(HEALTH_SETTLE_MS / 2);
  h.set([]);
  h.wait(HEALTH_SETTLE_MS * 2);
  assert.deepEqual(h.heard, []);
  h.done();
});

test("rapid flapping ends with one announcement describing where it landed", () => {
  const h = harness([]);
  for (let flip = 0; flip < 9; flip += 1) {
    h.set(flip % 2 === 0 ? [broken] : []);
    h.wait(50);
  }
  h.wait(HEALTH_SETTLE_MS);
  assert.deepEqual(h.heard.map(item => item.text), ["configuration raised"]);
  h.done();
});

test("repeated snapshots of the same failure announce once", () => {
  const h = harness([]);
  h.set([broken]);
  h.wait(HEALTH_SETTLE_MS);
  for (let poll = 0; poll < 5; poll += 1) {
    h.set([condition("configuration")]);
    h.wait(HEALTH_SETTLE_MS * 2);
  }
  assert.equal(h.heard.length, 1);
  h.done();
});

test("each distinct break and fix a developer makes is confirmed", () => {
  const h = harness([]);
  for (const state of [[broken], [], [broken], []]) {
    h.set(state);
    h.wait(HEALTH_SETTLE_MS);
  }
  assert.deepEqual(h.heard.map(item => item.tone), ["refuse", "accept", "refuse", "accept"]);
  h.done();
});

test("with the health panel open the panel is the feedback, so nothing is toasted", () => {
  const h = harness([], true);
  h.set([broken]);
  h.wait(HEALTH_SETTLE_MS);
  h.set([]);
  h.wait(HEALTH_SETTLE_MS);
  assert.deepEqual(h.heard, []);
  h.done();
});

test("closing the panel does not replay what it already showed", () => {
  const h = harness([], true);
  h.set([broken], true);
  h.wait(HEALTH_SETTLE_MS);
  h.set([broken], false);
  h.wait(HEALTH_SETTLE_MS * 2);
  assert.deepEqual(h.heard, []);
  h.done();
});
