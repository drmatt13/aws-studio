import { QueryClient } from "@tanstack/react-query";
import { after, before, test, type TestContext } from "node:test";
import { createRequire } from "node:module";
import assert from "./support/assert";

type Overview = Awaited<ReturnType<typeof import("../src/operations/api").operationsApi.list>>;
let operationsApi: typeof import("../src/operations/api").operationsApi;
let operationsQuery: typeof import("../src/operations/queries").operationsQuery;
let dom: { window: Window & typeof globalThis };
before(async () => {
  const { JSDOM } = createRequire(import.meta.url)("jsdom");
  dom = new JSDOM('<!doctype html><head><meta name="studio-token" content="fixture"></head>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  ({ operationsApi } = await import("../src/operations/api"));
  ({ operationsQuery } = await import("../src/operations/queries"));
});
after(() => dom.window.close());

const job: Overview["jobs"][number] = {
  id: "pending-operation", kind: "deploy-plan", title: "Prepare deployment", params: {},
  status: "running", startedAt: "2026-11-14T12:00:00.000Z", lastSeq: 1,
};

async function pendingRead(t: TestContext, jobs: Overview["jobs"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  client.setQueryData(operationsQuery().queryKey, { jobs });
  let respond!: (value: Overview) => void;
  const response = new Promise<Overview>(resolve => { respond = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const list = t.mock.method(operationsApi, "list", () => { markStarted(); return response; });
  const request = client.fetchQuery({ ...operationsQuery(), staleTime: 0 });
  await started;
  const current = () => client.getQueryData<Overview>(operationsQuery().queryKey)!.jobs;
  return { client, list, request, respond, current };
}

test("an equal-sequence terminal event survives a pending operations GET", async t => {
  const read = await pendingRead(t, [job]);
  const terminal = { ...job, status: "succeeded" as const };
  read.client.setQueryData(operationsQuery().queryKey, { jobs: [terminal] });
  read.respond({ jobs: [job] });
  await read.request;
  assert.deepEqual(read.current(), [terminal]);
});

test("a pending GET retains newer progress and a newly received job", async t => {
  const read = await pendingRead(t, [job]);
  const advanced = { ...job, lastSeq: 3 };
  const added = { ...job, id: "new-operation", startedAt: "2026-11-14T12:01:00.000Z" };
  read.client.setQueryData(operationsQuery().queryKey, { jobs: [added, advanced] });
  read.respond({ jobs: [{ ...job, lastSeq: 2 }] });
  await read.request;
  assert.deepEqual(read.current(), [added, advanced]);
});

test("a pending GET still prunes an untouched omitted job", async t => {
  const untouched = { ...job, id: "pruned-operation" };
  const read = await pendingRead(t, [job, untouched]);
  const advanced = { ...job, lastSeq: 3 };
  read.client.setQueryData(operationsQuery().queryKey, { jobs: [advanced, untouched] });
  read.respond({ jobs: [job] });
  await read.request;
  assert.deepEqual(read.current(), [advanced]);
});

test("a later uncontended GET can remove a job retained during the previous read", async t => {
  const read = await pendingRead(t, []);
  read.client.setQueryData(operationsQuery().queryKey, { jobs: [job] });
  read.respond({ jobs: [] });
  await read.request;
  assert.deepEqual(read.current(), [job]);
  read.list.mock.mockImplementation(async () => ({ jobs: [] }));
  await read.client.fetchQuery({ ...operationsQuery(), staleTime: 0 });
  assert.deepEqual(read.current(), []);
});

test("a newer server snapshot replaces an intervening event", async t => {
  const read = await pendingRead(t, [job]);
  read.client.setQueryData(operationsQuery().queryKey, { jobs: [{ ...job, lastSeq: 2 }] });
  const server = { ...job, lastSeq: 3, status: "succeeded" as const };
  read.respond({ jobs: [server] });
  await read.request;
  assert.deepEqual(read.current(), [server]);
});
