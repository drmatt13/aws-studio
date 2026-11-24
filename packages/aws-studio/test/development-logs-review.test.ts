import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePrivateDirectory } from "../cli/private-files";
import { DevelopmentLogReader } from "../src/local/development-logs/store";
import {
  DevelopmentTextFramer,
  sanitizeDevelopmentValue,
} from "../src/development-logs/sanitize";
import type {
  DevelopmentLogEvent,
  DevelopmentLogRun,
} from "../src/development-logs/contract";

const now = "2026-11-10T12:00:00.000Z";
const runId = "11111111-1111-4111-8111-111111111111";
const run: DevelopmentLogRun = {
  runtimeSessionId: runId,
  repositoryKey: "review-repository",
  composeProject: "review-project",
  bindingId: "review-binding",
  declarationDigest: "review-digest",
  startedAt: now,
  heartbeatAt: now,
  status: "collecting",
  binding: { deployment: "review-dev" },
  dropped: 0,
  truncated: 0,
  gaps: [],
};
function event(sequence: number, resourceId = "lambda:a"): DevelopmentLogEvent {
  return {
    schemaVersion: 1,
    eventId: `review:${sequence}`,
    source: "development",
    repositoryKey: run.repositoryKey,
    composeProject: run.composeProject,
    runtimeSessionId: runId,
    bindingId: run.bindingId,
    declarationDigest: run.declarationDigest,
    resource: { id: resourceId, kind: "lambda" },
    relatedResourceIds: [],
    producer: { component: "review", instanceId: "review-instance" },
    occurredAt: now,
    observedAt: now,
    ingestSequence: sequence,
    level: sequence % 127 === 0 ? "error" : "info",
    stream: "event",
    kind: "invocation.completed",
    correlation: {},
    attribution: "resource",
    message: "Safe execution output ".repeat(30),
    omissions: [],
  };
}
async function fixture(
  groups: readonly {
    resourceId: string;
    entries: readonly DevelopmentLogEvent[];
  }[],
  extraRun: Record<string, unknown> = {},
) {
  const directory = await mkdtemp(
    path.join(realpathSync(tmpdir()), "development-log-review-"),
  );
  ensurePrivateDirectory(directory);
  const runDirectory = path.join(directory, runId);
  await mkdir(runDirectory, { mode: 0o700 });
  const segments = [];
  for (const group of groups) {
    const file = `${randomUUID()}.ndjson`,
      content =
        group.entries.map((value) => JSON.stringify(value)).join("\n") + "\n";
    assert.ok(
      Buffer.byteLength(content) <= 256 * 1024,
      "Fixture segments obey actual byte limits",
    );
    await writeFile(path.join(runDirectory, file), content, { mode: 0o600 });
    segments.push({
      file,
      resourceId: group.resourceId,
      first: group.entries[0]!.ingestSequence,
      last: group.entries.at(-1)!.ingestSequence,
      count: group.entries.length,
      bytes: Buffer.byteLength(content),
      createdAt: now,
    });
  }
  await writeFile(
    path.join(runDirectory, "manifest.json"),
    JSON.stringify({ version: 1, run: { ...run, ...extraRun }, segments }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, "index.json"),
    JSON.stringify({
      version: 1,
      runs: [runId],
      nextSequence:
        Math.max(
          ...groups.flatMap((group) =>
            group.entries.map((item) => item.ingestSequence),
          ),
        ) + 1,
      cursorKey: "a".repeat(64),
    }),
    { mode: 0o600 },
  );
  return {
    directory,
    reader: new DevelopmentLogReader(directory, () => Date.parse(now)),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("reader reconstructs disk records and run metadata from an explicit allowlist", async () => {
  const poisoned = {
    ...event(1),
    futurePrivateField: "RAW_DISK_CANARY",
    producer: {
      component: "review",
      instanceId: "review-instance",
      futureSecret: "RAW_DISK_CANARY",
    },
  };
  const f = await fixture([{ resourceId: "lambda:a", entries: [poisoned] }], {
    futurePrivateField: "RAW_DISK_CANARY",
    binding: { deployment: "review-dev", futureSecret: "RAW_DISK_CANARY" },
  });
  try {
    assert.ok(
      !JSON.stringify(
        await f.reader.entries({ resourceIds: ["lambda:a"] }),
      ).includes("RAW_DISK_CANARY"),
    );
    assert.ok(
      !JSON.stringify(await f.reader.runs()).includes("RAW_DISK_CANARY"),
    );
  } finally {
    await f.close();
  }
});

test("multi-resource filtered pagination never skips overlapping resource ranges at scan limits", async () => {
  const all = Array.from({ length: 3000 }, (_, index) =>
    event(index + 1, index % 2 ? "lambda:b" : "lambda:a"),
  );
  const groups: { resourceId: string; entries: DevelopmentLogEvent[] }[] = [];
  for (const resourceId of ["lambda:a", "lambda:b"]) {
    const entries = all.filter((item) => item.resource.id === resourceId),
      chunkSize = resourceId === "lambda:a" ? 81 : 117;
    for (let index = 0; index < entries.length; index += chunkSize)
      groups.push({
        resourceId,
        entries: entries.slice(index, index + chunkSize),
      });
  }
  const f = await fixture(groups);
  try {
    let cursor: string | undefined;
    const found: number[] = [];
    for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
      const page = await f.reader.entries({
        resourceIds: ["lambda:a", "lambda:b"],
        level: "error",
        limit: 200,
        cursor,
      });
      found.push(...page.entries.map((item) => item.ingestSequence));
      if (!page.olderCursor) break;
      assert.notEqual(
        page.olderCursor,
        cursor,
        "A bounded empty-match scan must still advance its cursor",
      );
      cursor = page.olderCursor;
      assert.ok(pageNumber < 29, "Pagination must terminate");
    }
    assert.deepEqual(
      [...new Set(found)].sort((a, b) => a - b),
      all
        .filter((item) => item.level === "error")
        .map((item) => item.ingestSequence),
    );
    assert.equal(found.length, new Set(found).size);
  } finally {
    await f.close();
  }
});

test("an empty filtered scan cannot advance past an unread overlapping resource segment", async () => {
  const groups: { resourceId: string; entries: DevelopmentLogEvent[] }[] = [];
  for (const [resourceId, parity, chunkSize] of [
    ["lambda:a", 1, 81],
    ["lambda:b", 2, 117],
  ] as const) {
    const entries = Array.from({ length: 1500 }, (_, index) => ({
      ...event(index * 2 + parity, resourceId),
      level: "info" as const,
    }));
    for (let index = 0; index < entries.length; index += chunkSize)
      groups.push({
        resourceId,
        entries: entries.slice(index, index + chunkSize),
      });
  }
  const sorted = [...groups].sort(
    (a, b) =>
      b.entries.at(-1)!.ingestSequence - a.entries.at(-1)!.ingestSequence,
  );
  let bytes = 0,
    count = 0,
    loaded = 0;
  for (const group of sorted) {
    const size = Buffer.byteLength(
      group.entries.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    if (bytes + size > 2 * 1024 * 1024 || count >= 2000) break;
    bytes += size;
    count += group.entries.length;
    loaded++;
  }
  const unsafeFrontier = Math.min(
    ...sorted
      .slice(0, loaded)
      .flatMap((group) => group.entries.map((item) => item.ingestSequence)),
  );
  const canary = sorted
    .slice(loaded)
    .flatMap((group) => group.entries)
    .find((item) => item.ingestSequence > unsafeFrontier);
  assert.ok(
    canary,
    "Fixture must contain an unread record beyond the naive scan frontier",
  );
  Object.assign(canary, { level: "error", message: "Unread overlap canary" });
  const f = await fixture(groups);
  try {
    let cursor: string | undefined,
      found = false;
    for (let index = 0; index < 20; index++) {
      const page = await f.reader.entries({
        resourceIds: ["lambda:a", "lambda:b"],
        level: "error",
        cursor,
      });
      if (page.entries.some((item) => item.eventId === canary.eventId))
        found = true;
      if (!page.olderCursor) break;
      cursor = page.olderCursor;
    }
    assert.equal(
      found,
      true,
      "Filtering must not turn an overlapping unvisited record into invisible history loss",
    );
  } finally {
    await f.close();
  }
});

test("cursors bind resource filters and keep older pages at their original high-water mark", async () => {
  const f = await fixture([
    { resourceId: "lambda:a", entries: [event(1), event(2), event(3)] },
  ]);
  try {
    const first = await f.reader.entries({
      resourceIds: ["lambda:a"],
      limit: 1,
    });
    assert.deepEqual(
      first.entries.map((item) => item.ingestSequence),
      [3],
    );
    const manifestFile = path.join(f.directory, runId, "manifest.json"),
      manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const line = JSON.stringify(event(4)) + "\n";
    await appendFile(
      path.join(f.directory, runId, manifest.segments[0].file),
      line,
    );
    manifest.segments[0].last = 4;
    manifest.segments[0].count++;
    manifest.segments[0].bytes += Buffer.byteLength(line);
    await writeFile(manifestFile, JSON.stringify(manifest));
    const indexFile = path.join(f.directory, "index.json"),
      index = JSON.parse(await readFile(indexFile, "utf8"));
    index.nextSequence = 5;
    await writeFile(indexFile, JSON.stringify(index));
    const second = await f.reader.entries({
      resourceIds: ["lambda:a"],
      limit: 1,
      cursor: first.olderCursor,
    });
    assert.deepEqual(
      second.entries.map((item) => item.ingestSequence),
      [2],
    );
    assert.deepEqual(
      (
        await f.reader.entries({
          resourceIds: ["lambda:a"],
          cursor: first.nextCursor,
          direction: "newer",
        })
      ).entries.map((item) => item.ingestSequence),
      [4],
    );
    await assert.rejects(
      f.reader.entries({
        resourceIds: ["lambda:b"],
        cursor: first.olderCursor,
      }),
      /scope/,
    );
    await assert.rejects(
      f.reader.entries({
        resourceIds: ["lambda:a"],
        level: "error",
        cursor: first.olderCursor,
      }),
      /scope/,
    );
    await assert.rejects(
      f.reader.entries({
        resourceIds: ["lambda:a"],
        direction: "newer",
        cursor: first.olderCursor,
      }),
      /scope/,
    );
    const body = first.olderCursor!.split(".")[0];
    await assert.rejects(
      f.reader.entries({
        resourceIds: ["lambda:a"],
        cursor: `${body}.${"界".repeat(43)}`,
      }),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
  } finally {
    await f.close();
  }
});

const reservedFailureKinds = [
  "lambda.invocation.failed",
  "lambda.invocation.timed-out",
] as const;
const stderr = (sequence: number): DevelopmentLogEvent => ({
  ...event(sequence),
  level: "error",
  stream: "stderr",
  kind: "lambda.output",
  message: "Deprecation warning",
});
const failure = (
  sequence: number,
  resourceId = "lambda:a",
): DevelopmentLogEvent => ({
  ...event(sequence, resourceId),
  level: "error",
  kind: "lambda.invocation.failed",
  outcome: "failed",
  message: "Recorded terminal failure",
});

test("a reserved terminal failure survives more than eight newer stderr records within its resource and run", async () => {
  const f = await fixture([
    {
      resourceId: "lambda:a",
      entries: [
        failure(1),
        ...Array.from({ length: 17 }, (_, index) => stderr(index + 2)),
        {
          ...failure(19),
          runtimeSessionId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    },
    { resourceId: "lambda:b", entries: [failure(20, "lambda:b")] },
  ]);
  try {
    const page = await f.reader.entries({
      resourceIds: ["lambda:a"],
      runId,
      level: "error",
      limit: 8,
      reserveKinds: reservedFailureKinds,
    });
    assert.deepEqual(
      page.entries.map((item) => item.ingestSequence),
      [1, 12, 13, 14, 15, 16, 17, 18],
    );
    assert.ok(page.olderCursor, "Skipped stderr remains unread history");
    assert.ok(page.entries.every((item) => item.resource.id === "lambda:a"));
    assert.ok(page.entries.every((item) => item.runtimeSessionId === runId));
    assert.ok(page.gaps.some((gap) => gap.reason === "source-unavailable"));
  } finally {
    await f.close();
  }
});

test("a reservation without a matching terminal failure keeps the ordinary newest eight errors", async () => {
  const f = await fixture([
    {
      resourceId: "lambda:a",
      entries: Array.from({ length: 20 }, (_, index) => stderr(index + 1)),
    },
  ]);
  try {
    const page = await f.reader.entries({
      resourceIds: ["lambda:a"],
      level: "error",
      limit: 8,
      reserveKinds: reservedFailureKinds,
    });
    assert.deepEqual(
      page.entries.map((item) => item.ingestSequence),
      [13, 14, 15, 16, 17, 18, 19, 20],
    );
    assert.ok(
      page.olderCursor,
      "A complete search does not make skipped errors read",
    );
  } finally {
    await f.close();
  }
});

test("the newest matching reserved kind already inside the tail does not bring back an older failure", async () => {
  const f = await fixture([
    {
      resourceId: "lambda:a",
      entries: [
        failure(1),
        ...Array.from({ length: 15 }, (_, index) => stderr(index + 2)),
        { ...failure(17), kind: "lambda.invocation.timed-out" },
        stderr(18),
      ],
    },
  ]);
  try {
    const page = await f.reader.entries({
      resourceIds: ["lambda:a"],
      level: "error",
      limit: 8,
      reserveKinds: reservedFailureKinds,
    });
    assert.deepEqual(
      page.entries.map((item) => item.ingestSequence),
      [11, 12, 13, 14, 15, 16, 17, 18],
    );
  } finally {
    await f.close();
  }
});

test("reserved cursors bind the selection policy and preserve skipped middle errors on continuation", async () => {
  const all = [
    failure(1),
    ...Array.from({ length: 17 }, (_, index) => stderr(index + 2)),
  ];
  const f = await fixture([{ resourceId: "lambda:a", entries: all }]);
  try {
    const query = {
      resourceIds: ["lambda:a"],
      level: "error" as const,
      limit: 8,
      reserveKinds: reservedFailureKinds,
    };
    const first = await f.reader.entries(query);
    assert.ok(first.olderCursor);
    await assert.rejects(
      f.reader.entries({
        resourceIds: query.resourceIds,
        level: query.level,
        limit: query.limit,
        cursor: first.olderCursor,
      }),
      /scope/,
    );
    await assert.rejects(
      f.reader.entries({
        ...query,
        reserveKinds: ["lambda.failed"],
        cursor: first.olderCursor,
      }),
      /scope/,
    );
    const found = new Set(first.entries.map((item) => item.ingestSequence));
    let cursor: string | undefined = first.olderCursor;
    for (let pageNumber = 0; cursor && pageNumber < 10; pageNumber++) {
      const page = await f.reader.entries({
        ...query,
        reserveKinds: [...reservedFailureKinds].reverse(),
        cursor,
      });
      page.entries.forEach((item) => found.add(item.ingestSequence));
      if (page.olderCursor) assert.notEqual(page.olderCursor, cursor);
      cursor = page.olderCursor;
    }
    assert.equal(
      cursor,
      undefined,
      "A reserved ordinary prefix still advances to the end",
    );
    assert.deepEqual(
      [...found].sort((a, b) => a - b),
      all.map((item) => item.ingestSequence),
    );
  } finally {
    await f.close();
  }
});

test("reservation searches stop at the existing record scan cap before an older failure", async () => {
  const entries = [
    failure(1),
    ...Array.from({ length: 2100 }, (_, index) => stderr(index + 2)),
  ];
  assert.ok(
    Buffer.byteLength(entries.map((item) => JSON.stringify(item)).join("\n")) <
      2 * 1024 * 1024,
  );
  const groups = [];
  for (let index = 0; index < entries.length; index += 100)
    groups.push({
      resourceId: "lambda:a",
      entries: entries.slice(index, index + 100),
    });
  const f = await fixture(groups);
  try {
    const page = await f.reader.entries({
      resourceIds: ["lambda:a"],
      level: "error",
      limit: 8,
      reserveKinds: reservedFailureKinds,
    });
    assert.deepEqual(
      page.entries.map((item) => item.ingestSequence),
      [2094, 2095, 2096, 2097, 2098, 2099, 2100, 2101],
    );
    assert.ok(page.olderCursor);
    assert.ok(
      page.gaps.some(
        (gap) =>
          gap.reason === "truncated" && gap.message.includes("scan limit"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("reservation searches stop at the existing byte scan cap before an older failure", async () => {
  const entries = [
    failure(1),
    ...Array.from({ length: 1799 }, (_, index) => ({
      ...stderr(index + 2),
      message: "w".repeat(1000),
    })),
  ];
  assert.ok(
    Buffer.byteLength(entries.map((item) => JSON.stringify(item)).join("\n")) >
      2 * 1024 * 1024,
  );
  const groups = [];
  for (let index = 0; index < entries.length; index += 100)
    groups.push({
      resourceId: "lambda:a",
      entries: entries.slice(index, index + 100),
    });
  const f = await fixture(groups);
  try {
    const page = await f.reader.entries({
      resourceIds: ["lambda:a"],
      level: "error",
      limit: 8,
      reserveKinds: reservedFailureKinds,
    });
    assert.deepEqual(
      page.entries.map((item) => item.ingestSequence),
      [1793, 1794, 1795, 1796, 1797, 1798, 1799, 1800],
    );
    assert.ok(page.olderCursor);
    assert.ok(
      page.gaps.some(
        (gap) =>
          gap.reason === "truncated" && gap.message.includes("scan limit"),
      ),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 256 * 1024);
  } finally {
    await f.close();
  }
});

test("reserved selection validates bounded unique kinds and requires an advancing older prefix", async () => {
  const f = await fixture([
    { resourceId: "lambda:a", entries: [failure(1), stderr(2)] },
  ]);
  try {
    for (const invalid of [
      { reserveKinds: [] },
      {
        reserveKinds: ["lambda.invocation.failed", "lambda.invocation.failed"],
      },
      {
        reserveKinds: Array.from(
          { length: 17 },
          (_, index) => `failure.${index}`,
        ),
      },
      { reserveKinds: ["x".repeat(97)] },
      { reserveKinds: reservedFailureKinds, limit: 1 },
      { reserveKinds: reservedFailureKinds, direction: "newer" as const },
    ]) {
      await assert.rejects(
        f.reader.entries({ resourceIds: ["lambda:a"], limit: 8, ...invalid }),
        (error: unknown) => (error as { status?: number }).status === 400,
      );
    }
  } finally {
    await f.close();
  }
});

test("overview reads only its deliberately scoped lifecycle/error journal", async () => {
  const included = event(2),
    excluded = {
      ...event(1),
      stream: "stdout" as const,
      message: "Ordinary stdout outside overview",
    };
  const f = await fixture([
    { resourceId: "lambda:a", entries: [excluded] },
    { resourceId: "__overview__", entries: [included] },
  ]);
  try {
    assert.deepEqual(
      (await f.reader.entries()).entries.map((item) => item.eventId),
      [included.eventId],
    );
  } finally {
    await f.close();
  }
});

test("nested and form payloads are sanitized before preview truncation", () => {
  for (const input of [
    {
      details:
        '{ "nested": { "accessToken" : "NESTED_CANARY", "safe": "kept" } }',
    },
    { details: "safe=kept&refresh_token=FORM_CANARY" },
  ]) {
    const value = JSON.stringify(sanitizeDevelopmentValue(input));
    assert.ok(!value.includes("NESTED_CANARY"));
    assert.ok(!value.includes("FORM_CANARY"));
  }
});

test("stream framing withholds known secret prefixes at a truncated process exit", () => {
  const lines: string[] = [],
    framer = new DevelopmentTextFramer(
      (line) => lines.push(line),
      ["COMPLETE_SECRET_CANARY"],
    );
  framer.push("Safe prefix COMPLETE_SECRET_");
  framer.flush();
  assert.ok(!lines.join("").includes("COMPLETE_SECRET_"));
});
