/** Writes private development logs and reads bounded, validated cache pages. */
import path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lstat, open, readdir, unlink, rmdir } from "node:fs/promises";
import {
  DEVELOPMENT_LOG_LIMITS as defaults,
  type DevelopmentLogControl,
  type DevelopmentLogEvent,
  type DevelopmentLogGap,
  type DevelopmentLogPage,
  type DevelopmentLogQuery,
  type DevelopmentLogRun,
  type DevelopmentLogTraceQuery,
  type DevelopmentLogTracePage,
  type DevelopmentObservation,
} from "../../development-logs/contract";
import { sanitizeDevelopmentObservation } from "../../development-logs/context";
import {
  acquireDevelopmentLogWriter,
  assertLogDirectory,
  assertLogFile,
  createLogFile,
  readLogFile,
  writeLogJson,
} from "./files";

interface Segment {
  file: string;
  resourceId: string;
  first: number;
  last: number;
  count: number;
  bytes: number;
  createdAt: string;
  /** Primary records only; bounded metadata avoids another copy of the event stream. */
  traceIds?: string[];
}
interface Manifest {
  version: 1;
  run: DevelopmentLogRun;
  segments: Segment[];
  producers?: Record<string, number>;
}
interface Index {
  version: 1;
  runs: string[];
  nextSequence: number;
  cursorKey: string;
}
type Limits = { -readonly [K in keyof typeof defaults]: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const segmentName = /^[a-f0-9-]+\.ndjson$/;
const ownedTemporary = (name: string, base: "index" | "manifest") => {
  const match = /^(index|manifest)\.json\.(.+)\.tmp$/.exec(name);
  return !!match && match[1] === base && uuid.test(match[2]!);
};
const ownedSegment = (name: string) => {
  const match = /^(.{36})-(.{36})\.ndjson$/.exec(name);
  return !!match && uuid.test(match[1]!) && uuid.test(match[2]!);
};
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function indexAt(directory: string): Promise<Index | undefined> {
  try {
    const value = JSON.parse(
      await readLogFile(path.join(directory, "index.json"), 64 * 1024),
    ) as Index;
    if (
      value.version !== 1 ||
      !Array.isArray(value.runs) ||
      value.runs.length > 20 ||
      new Set(value.runs).size !== value.runs.length ||
      !value.runs.every((id) => typeof id === "string" && uuid.test(id)) ||
      !Number.isSafeInteger(value.nextSequence) ||
      value.nextSequence < 1 ||
      !/^[a-f0-9]{64}$/.test(value.cursorKey)
    )
      throw new Error("Invalid development log index.");
    return {
      version: 1,
      runs: value.runs,
      nextSequence: value.nextSequence,
      cursorKey: value.cursorKey,
    };
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}
async function manifestAt(directory: string, runId: string): Promise<Manifest> {
  if (!uuid.test(runId)) throw new Error("Invalid development log run.");
  const value = JSON.parse(
    await readLogFile(
      path.join(directory, runId, "manifest.json"),
      defaults.metadataBytes,
    ),
  ) as Manifest;
  if (
    value.version !== 1 ||
    value.run?.runtimeSessionId !== runId ||
    !Array.isArray(value.segments) ||
    value.segments.length > 8192 ||
    new Set(value.segments.map((item) => item.file)).size !==
      value.segments.length ||
    !value.segments.every(
      (s) =>
        segmentName.test(s.file) &&
        typeof s.resourceId === "string" &&
        s.resourceId.length <= 1024 &&
        Number.isSafeInteger(s.bytes) &&
        s.bytes > 0 &&
        s.bytes <= defaults.segmentBytes + defaults.recordBytes &&
        Number.isSafeInteger(s.first) &&
        s.first > 0 &&
        Number.isSafeInteger(s.last) &&
        s.last >= s.first &&
        Number.isSafeInteger(s.count) &&
        s.count > 0 &&
        s.count <= defaults.records &&
        typeof s.createdAt === "string" &&
        Number.isFinite(Date.parse(s.createdAt)) &&
        (s.traceIds === undefined ||
          (Array.isArray(s.traceIds) &&
            s.traceIds.length <= 128 &&
            new Set(s.traceIds).size === s.traceIds.length &&
            s.traceIds.every(
              (id) =>
                typeof id === "string" &&
                id.length <= 256 &&
                !/[\r\n\0]/.test(id),
            ))),
    )
  )
    throw new Error("Invalid development log manifest.");
  const producers: Record<string, number> = Object.create(null);
  if (value.producers !== undefined) {
    if (
      !value.producers ||
      typeof value.producers !== "object" ||
      Array.isArray(value.producers) ||
      Object.keys(value.producers).length > 1024
    )
      throw new Error("Invalid development log producers.");
    for (const [id, sequence] of Object.entries(value.producers)) {
      if (
        !uuid.test(id) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        sequence > 999_999_999_999
      )
        throw new Error("Invalid development log producer sequence.");
      producers[id] = sequence;
    }
  }
  return {
    version: 1,
    run: safeRun(value.run),
    segments: value.segments.map((s) => ({
      file: s.file,
      resourceId: s.resourceId,
      first: s.first,
      last: s.last,
      count: s.count,
      bytes: s.bytes,
      createdAt: s.createdAt,
      ...(s.traceIds === undefined ? {} : { traceIds: s.traceIds }),
    })),
    producers,
  };
}
export class DevelopmentLogStore {
  private index!: Index;
  private manifests = new Map<string, Manifest>();
  private readonly limits: Limits;
  private readonly instance = randomUUID();
  private lock?: Awaited<ReturnType<typeof acquireDevelopmentLogWriter>>;
  private initialized = false;
  private closing = false;
  private closed = false;
  private failed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private queuedRecords = 0;
  private queuedBytes = 0;
  private pendingDrops = 0;
  private pendingDropMessage =
    "Observations dropped while collection was unavailable.";
  private dirty = new Set<string>();
  private indexDirty = false;
  private deletes: { runId: string; file: string }[] = [];
  private retired = new Set<string>();
  private heartbeatPending?: Promise<void>;
  private activeSegments = new Map<string, Segment>();
  private lastDirectoryAudit = -Infinity;
  private directoryOverheadBytes = 0;
  constructor(
    readonly directory: string,
    readonly control: DevelopmentLogControl,
    options: { limits?: Partial<Limits>; now?: () => number } = {},
  ) {
    this.limits = { ...defaults };
    for (const [key, value] of Object.entries(options.limits ?? {})) {
      if (!Number.isSafeInteger(value) || value! <= 0)
        throw new Error("Development log limits must be positive integers.");
      const name = key as keyof Limits;
      this.limits[name] = Math.min(defaults[name], value!);
    }
    this.now = options.now ?? Date.now;
  }
  private readonly now: () => number;
  private stamp() {
    return new Date(this.now()).toISOString();
  }
  async initialize(): Promise<void> {
    if (this.initialized && !this.closed && !this.failed) return;
    if (this.closed || this.failed)
      throw new Error(
        "Use a new development log writer after closure or failure.",
      );
    try {
      this.lock = await acquireDevelopmentLogWriter(this.directory);
      if (!uuid.test(this.control.runtimeSessionId))
        throw new Error("Invalid runtime session.");
      this.index = (await indexAt(this.directory)) ?? {
        version: 1,
        runs: [],
        nextSequence: 1,
        cursorKey: randomBytes(32).toString("hex"),
      };
      const children = await readdir(this.directory, { withFileTypes: true });
      if (children.length > 128)
        throw new Error("Development log directory contains too many entries.");
      const discovered = [
        ...new Set([
          ...this.index.runs,
          ...children
            .filter((entry) => uuid.test(entry.name) && entry.isDirectory())
            .map((entry) => entry.name),
        ]),
      ];
      if (discovered.length > 40)
        throw new Error(
          "Development log run capacity exceeded during recovery.",
        );
      for (const id of discovered) {
        let manifest: Manifest;
        try {
          manifest = await manifestAt(this.directory, id);
        } catch (error) {
          if (!missing(error)) throw error;
          await this.recoverFiles(id);
          continue;
        }
        if (
          manifest.run.repositoryKey !== this.control.repositoryKey ||
          manifest.run.composeProject !== this.control.composeProject
        )
          throw new Error("Development log project identity does not match.");
        this.manifests.set(id, manifest);
        for (const segment of manifest.segments)
          this.index.nextSequence = Math.max(
            this.index.nextSequence,
            segment.last + 1,
          );
        await this.recoverFiles(id, manifest);
        if (
          id !== this.control.runtimeSessionId &&
          manifest.run.status === "collecting"
        ) {
          manifest.run = {
            ...manifest.run,
            status: "stopped",
            endedAt: this.stamp(),
            gaps: [
              ...manifest.run.gaps.slice(-63),
              {
                reason: "restart",
                at: this.stamp(),
                message:
                  "Collection ownership changed. The previous execution outcome is unknown.",
              },
            ],
          };
          this.dirty.add(id);
        }
      }
      const existing = this.manifests.get(this.control.runtimeSessionId);
      if (
        existing &&
        (existing.run.bindingId !== this.control.bindingId ||
          existing.run.declarationDigest !== this.control.declarationDigest)
      )
        throw new Error("Development log run binding changed.");
      const run = safeRun(
        existing?.run ?? {
          runtimeSessionId: this.control.runtimeSessionId,
          repositoryKey: this.control.repositoryKey,
          composeProject: this.control.composeProject,
          bindingId: this.control.bindingId,
          declarationDigest: this.control.declarationDigest,
          binding: this.control.binding,
          startedAt: this.control.startedAt,
          status: "collecting",
          dropped: 0,
          truncated: 0,
          gaps: [],
        },
      );
      const manifest: Manifest = existing ?? {
        version: 1,
        run,
        segments: [],
        producers: Object.create(null),
      };
      manifest.run = {
        ...run,
        status: "collecting",
        endedAt: undefined,
        heartbeatAt: this.stamp(),
        gaps: existing
          ? [
              ...run.gaps.slice(-63),
              {
                reason: "restart",
                at: this.stamp(),
                message:
                  "Collector restarted; execution recovery is not implied.",
              },
            ]
          : run.gaps,
      };
      this.manifests.set(run.runtimeSessionId, manifest);
      this.index.runs = [
        run.runtimeSessionId,
        ...[...this.manifests.values()]
          .filter((item) => item.run.runtimeSessionId !== run.runtimeSessionId)
          .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
          .map((item) => item.run.runtimeSessionId),
      ];
      this.dirty.add(run.runtimeSessionId);
      this.indexDirty = true;
      await assertLogDirectory(
        path.join(this.directory, run.runtimeSessionId),
        true,
      );
      await this.recoverRootTemporaryFiles();
      await this.prune();
      await this.publish();
      await this.assertDirectoryBudget(true);
      this.initialized = true;
    } catch (error) {
      await this.fail();
      throw error;
    }
  }
  append(
    events: readonly {
      observation: DevelopmentObservation;
      eventId: string;
      producer: DevelopmentLogEvent["producer"];
    }[],
  ): Promise<void> {
    if (!this.initialized || this.closing || this.closed || this.failed)
      return Promise.reject(
        new Error("Development log writer is unavailable."),
      );
    const records = Math.min(events.length, defaults.batchRecords),
      bytes = records * this.limits.recordBytes;
    if (events.length > defaults.batchRecords)
      this.drop(
        events.length - defaults.batchRecords,
        "Oversized batches were bounded.",
      );
    if (
      this.queuedRecords + records > this.limits.collectorRecords ||
      this.queuedBytes + bytes > this.limits.collectorBytes
    ) {
      this.drop(records, "Writer queue capacity reached.");
      return Promise.resolve();
    }
    this.queuedRecords += records;
    this.queuedBytes += bytes;
    const work = this.writes.then(async () => {
      try {
        if (this.failed || this.closed)
          throw new Error("Development log writer is unavailable.");
        await this.appendNow(events.slice(0, defaults.batchRecords));
      } catch (error) {
        await this.fail();
        throw error;
      } finally {
        this.queuedRecords -= records;
        this.queuedBytes -= bytes;
      }
    });
    this.writes = work.catch(() => {});
    return work;
  }
  private async appendNow(
    events: readonly {
      observation: DevelopmentObservation;
      eventId: string;
      producer: DevelopmentLogEvent["producer"];
    }[],
  ): Promise<void> {
    await this.lock!.assertOwned();
    const manifest = this.manifests.get(this.control.runtimeSessionId)!;
    this.applyPendingDrops(manifest);
    const chunks = new Map<Segment, string[]>();
    for (const input of events) {
      const producerMatch = /^([a-f0-9-]{36}):(\d{1,12})$/i.exec(input.eventId);
      if (
        !producerMatch ||
        !uuid.test(producerMatch[1]!) ||
        !input.producer ||
        input.producer.instanceId !== producerMatch[1] ||
        !validText(input.producer.component, 64)
      ) {
        this.drop(1, "Invalid producer evidence was omitted.");
        continue;
      }
      const producers =
        manifest.producers ?? (manifest.producers = Object.create(null));
      const producerSequence = Number(producerMatch[2]),
        previousSequence = producers[producerMatch[1]!] ?? 0;
      if (producerSequence <= previousSequence) continue;
      if (
        producers[producerMatch[1]!] === undefined &&
        Object.keys(producers).length >= 1024
      ) {
        this.drop(1, "Producer capacity reached.");
        continue;
      }
      const observation = sanitizeDevelopmentObservation(input.observation);
      const sequence = this.index.nextSequence++;
      const { resourceId, ...fields } = observation;
      const producer = {
        component: safeMetadataText(input.producer.component, 64),
        instanceId: producerMatch[1]!,
        ...(validText(input.producer.workerId, 160)
          ? { workerId: safeMetadataText(input.producer.workerId, 160) }
          : {}),
        ...(validText(input.producer.containerId, 160)
          ? { containerId: safeMetadataText(input.producer.containerId, 160) }
          : {}),
      };
      const event: DevelopmentLogEvent = {
        ...fields,
        schemaVersion: 1,
        eventId: input.eventId,
        source: "development",
        repositoryKey: manifest.run.repositoryKey,
        composeProject: manifest.run.composeProject,
        runtimeSessionId: manifest.run.runtimeSessionId,
        bindingId: manifest.run.bindingId,
        declarationDigest: manifest.run.declarationDigest,
        resource: {
          id: resourceId,
          kind: resourceId.split(":")[0] ?? "resource",
        },
        producer,
        observedAt: this.stamp(),
        ingestSequence: sequence,
      };
      const line = JSON.stringify(event) + "\n",
        bytes = Buffer.byteLength(line);
      if (bytes > this.limits.recordBytes) {
        this.drop(1, "Oversized observation omitted.");
        continue;
      }
      const resources = [
        ...new Set([resourceId, ...observation.relatedResourceIds]),
      ].slice(0, 4);
      if (
        observation.stream === "event" ||
        observation.level === "error" ||
        observation.level === "warn"
      )
        resources.push("__overview__");
      for (const id of resources) {
        let segment = this.activeSegments.get(id);
        const traceId =
          id === resourceId ? observation.correlation.traceId : undefined;
        if (
          !segment ||
          segment.bytes + bytes > this.limits.segmentBytes ||
          (traceId &&
            !segment.traceIds?.includes(traceId) &&
            (segment.traceIds?.length ?? 0) >= 128)
        ) {
          segment = {
            file: `${this.instance}-${randomUUID()}.ndjson`,
            resourceId: id,
            first: sequence,
            last: sequence,
            count: 0,
            bytes: 0,
            createdAt: this.stamp(),
            traceIds: [],
          };
          manifest.segments.push(segment);
          this.activeSegments.set(id, segment);
        }
        const lines = chunks.get(segment) ?? [];
        lines.push(line);
        chunks.set(segment, lines);
        segment.bytes += bytes;
        segment.count++;
        segment.last = sequence;
        if (traceId && !segment.traceIds!.includes(traceId))
          segment.traceIds!.push(traceId);
      }
      if (
        event.omissions.some((o) => o.reason === "size" || o.reason === "depth")
      )
        manifest.run = {
          ...manifest.run,
          truncated: manifest.run.truncated + 1,
        };
      if (producerSequence > previousSequence + 1)
        manifest.run = {
          ...manifest.run,
          gaps: [
            ...manifest.run.gaps.slice(-63),
            {
              reason: "dropped",
              at: this.stamp(),
              count: producerSequence - previousSequence - 1,
              message:
                "Producer sequence gap; observations may have been dropped before collection.",
            },
          ],
        };
      producers[producerMatch[1]!] = producerSequence;
    }
    // One append+fsync per touched segment per batch, rather than per observation/fan-out.
    for (const [segment, lines] of chunks) {
      const file = path.join(
          this.directory,
          this.control.runtimeSessionId,
          segment.file,
        ),
        text = lines.join(""),
        previousBytes = segment.bytes - Buffer.byteLength(text);
      if (!previousBytes) createLogFile(file);
      const identity = await assertLogFile(
        file,
        this.limits.segmentBytes + this.limits.recordBytes,
      );
      if (identity.size !== previousBytes)
        throw new Error("Development log segment changed.");
      const handle = await open(file, "a");
      try {
        const opened = await handle.stat();
        if (
          opened.ino !== identity.ino ||
          opened.dev !== identity.dev ||
          opened.nlink !== 1
        )
          throw new Error("Development log segment identity changed.");
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    this.applyPendingDrops(manifest);
    manifest.run = { ...manifest.run, heartbeatAt: this.stamp() };
    this.dirty.add(manifest.run.runtimeSessionId);
    this.indexDirty ||= events.length > 0;
    await this.prune();
    await this.lock!.assertOwned();
    await this.publish();
    await this.assertDirectoryBudget();
  }
  drop(
    count: number,
    message = "Observations dropped while collection was unavailable.",
  ): void {
    if (!Number.isSafeInteger(count) || count < 1) return;
    this.pendingDrops = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.pendingDrops + count,
    );
    this.pendingDropMessage = safeMetadataText(message, 1024);
  }
  private applyPendingDrops(manifest: Manifest): void {
    if (!this.pendingDrops) return;
    const count = this.pendingDrops;
    this.pendingDrops = 0;
    manifest.run = {
      ...manifest.run,
      dropped: Math.min(Number.MAX_SAFE_INTEGER, manifest.run.dropped + count),
      gaps: [
        ...manifest.run.gaps.slice(-63),
        {
          reason: "dropped",
          at: this.stamp(),
          count,
          message: this.pendingDropMessage,
        },
      ],
    };
  }
  heartbeat(): Promise<void> {
    this.heartbeatPending ??= this.append([]).finally(() => {
      this.heartbeatPending = undefined;
    });
    return this.heartbeatPending;
  }
  private async recoverRootTemporaryFiles(): Promise<void> {
    for (const entry of await readdir(this.directory, { withFileTypes: true }))
      if (ownedTemporary(entry.name, "index")) {
        const file = path.join(this.directory, entry.name);
        await assertLogFile(file, defaults.metadataBytes);
        await unlink(file);
      }
  }
  private async recoverFiles(
    runId: string,
    manifest?: Manifest,
  ): Promise<void> {
    const directory = path.join(this.directory, runId);
    await assertLogDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 16_384)
      throw new Error("Development log recovery file capacity exceeded.");
    const known = new Map(
      (manifest?.segments ?? []).map((segment) => [segment.file, segment]),
    );
    for (const entry of entries) {
      const file = path.join(directory, entry.name),
        segment = known.get(entry.name);
      if (segment) {
        const info = await assertLogFile(
          file,
          defaults.segmentBytes + defaults.recordBytes,
        );
        if (info.size < segment.bytes) {
          manifest!.segments = manifest!.segments.filter(
            (item) => item !== segment,
          );
          manifest!.run = {
            ...manifest!.run,
            gaps: [
              ...manifest!.run.gaps.slice(-63),
              {
                reason: "storage",
                at: this.stamp(),
                count: segment.count,
                message:
                  "An incomplete cached segment was omitted during recovery.",
              },
            ],
          };
          this.dirty.add(runId);
          this.deletes.push({ runId, file: entry.name });
        } else if (info.size > segment.bytes) {
          const handle = await open(file, "r+");
          try {
            const opened = await handle.stat();
            if (opened.ino !== info.ino || opened.dev !== info.dev)
              throw new Error("Development log recovery path changed.");
            await handle.truncate(segment.bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          manifest!.run = {
            ...manifest!.run,
            gaps: [
              ...manifest!.run.gaps.slice(-63),
              {
                reason: "restart",
                at: this.stamp(),
                message:
                  "An uncommitted output tail was discarded during collector recovery.",
              },
            ],
          };
          this.dirty.add(runId);
        }
      } else if (
        ownedSegment(entry.name) ||
        ownedTemporary(entry.name, "manifest")
      ) {
        await assertLogFile(
          file,
          defaults.segmentBytes + defaults.metadataBytes,
        );
        await unlink(file);
      }
    }
    if (manifest)
      for (const segment of [...manifest.segments])
        if (!entries.some((entry) => entry.name === segment.file)) {
          manifest.segments = manifest.segments.filter(
            (item) => item !== segment,
          );
          manifest.run = {
            ...manifest.run,
            gaps: [
              ...manifest.run.gaps.slice(-63),
              {
                reason: "storage",
                at: this.stamp(),
                count: segment.count,
                message:
                  "A missing cached segment was omitted during recovery.",
              },
            ],
          };
          this.dirty.add(runId);
        }
  }
  private async prune(): Promise<void> {
    const all = () =>
      [...this.manifests.values()].flatMap((m) =>
        m.segments.map((s) => ({ m, s })),
      );
    const remove = (m: Manifest, s: Segment) => {
      if (this.activeSegments.get(s.resourceId) === s)
        this.activeSegments.delete(s.resourceId);
      m.segments = m.segments.filter((item) => item !== s);
      m.run = {
        ...m.run,
        gaps: [
          ...m.run.gaps
            .filter(
              (g) =>
                !(g.reason === "retention" && g.resourceId === s.resourceId),
            )
            .slice(-63),
          {
            reason: "retention",
            at: this.stamp(),
            count: s.count,
            resourceId: s.resourceId,
            message:
              "Older cached observations expired or reached retention limits.",
          },
        ],
      };
      this.dirty.add(m.run.runtimeSessionId);
      this.deletes.push({ runId: m.run.runtimeSessionId, file: s.file });
    };
    for (const { m, s } of all())
      if (Date.parse(s.createdAt) < this.now() - this.limits.ageMs)
        remove(m, s);
    const resources = new Map<string, { bytes: number; count: number }>();
    for (const { s } of all()) {
      const n = resources.get(s.resourceId) ?? { bytes: 0, count: 0 };
      n.bytes += s.bytes;
      n.count += s.count;
      resources.set(s.resourceId, n);
    }
    for (const { m, s } of all().sort((a, b) => a.s.first - b.s.first)) {
      const n = resources.get(s.resourceId)!;
      if (
        n.bytes >
          (s.resourceId === "__overview__"
            ? Math.min(2 * 1024 * 1024, this.limits.resourceBytes)
            : this.limits.resourceBytes) ||
        n.count >
          (s.resourceId === "__overview__"
            ? Math.min(2000, this.limits.resourceRecords)
            : this.limits.resourceRecords)
      ) {
        remove(m, s);
        n.bytes -= s.bytes;
        n.count -= s.count;
      }
    }
    let entries = all(),
      bytes = entries.reduce((n, x) => n + x.s.bytes, 0),
      count = entries.reduce((n, x) => n + x.s.count, 0);
    for (const { m, s } of entries.sort((a, b) => a.s.first - b.s.first))
      if (
        bytes > this.limits.bytes ||
        count > this.limits.records ||
        entries.length > 8192
      ) {
        remove(m, s);
        bytes -= s.bytes;
        count -= s.count;
        entries = entries.filter((x) => x.s !== s);
      }
    const retired = this.index.runs.filter(
      (id, i) =>
        id !== this.control.runtimeSessionId &&
        (i >= this.limits.runs ||
          Date.parse(this.manifests.get(id)!.run.startedAt) <
            this.now() - this.limits.ageMs),
    );
    for (const id of retired) {
      const m = this.manifests.get(id)!;
      for (const s of [...m.segments]) remove(m, s);
      this.manifests.delete(id);
      this.dirty.delete(id);
      this.index.runs = this.index.runs.filter((r) => r !== id);
      this.indexDirty = true;
      this.retired.add(id);
    }
    const metadataSize = () =>
      [...this.manifests.values()].reduce(
        (sum, manifest) => sum + Buffer.byteLength(JSON.stringify(manifest)),
        Buffer.byteLength(JSON.stringify(this.index)),
      );
    const candidates = all().sort((a, b) => a.s.first - b.s.first);
    let metadata = metadataSize(),
      offset = 0;
    while (metadata > this.limits.metadataBytes && offset < candidates.length) {
      const average =
        candidates
          .slice(offset)
          .reduce(
            (sum, item) => sum + Buffer.byteLength(JSON.stringify(item.s)) + 1,
            0,
          ) /
        (candidates.length - offset);
      const count = Math.max(
        1,
        Math.ceil(
          (metadata - this.limits.metadataBytes) / Math.max(1, average),
        ),
      );
      for (
        let index = 0;
        index < count && offset < candidates.length;
        index++
      ) {
        const { m, s } = candidates[offset++]!;
        remove(m, s);
      }
      metadata = metadataSize();
    }
    if (metadata > this.limits.metadataBytes)
      throw new Error("Development log metadata capacity reached.");
  }
  private async publish(): Promise<void> {
    await this.lock!.assertOwned();
    for (const id of this.dirty) {
      const manifest = this.manifests.get(id);
      if (manifest)
        await writeLogJson(
          path.join(this.directory, id, "manifest.json"),
          manifest,
        );
    }
    if (this.indexDirty)
      await writeLogJson(path.join(this.directory, "index.json"), this.index);
    // Published absence is authoritative before unlinking retired files, including on Windows.
    for (const entry of this.deletes) {
      const file = path.join(this.directory, entry.runId, entry.file);
      try {
        await assertLogFile(file, defaults.segmentBytes + defaults.recordBytes);
        await unlink(file);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    for (const id of this.retired) {
      await unlink(path.join(this.directory, id, "manifest.json")).catch(
        (error) => {
          if (!missing(error)) throw error;
        },
      );
      await rmdir(path.join(this.directory, id)).catch((error) => {
        if (
          !["ENOENT", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      });
    }
    this.dirty.clear();
    this.indexDirty = false;
    this.deletes = [];
    this.retired.clear();
  }
  private knownBytes(): number {
    return [...this.manifests.values()].reduce(
      (sum, manifest) =>
        sum +
        manifest.segments.reduce((size, segment) => size + segment.bytes, 0) +
        Buffer.byteLength(JSON.stringify(manifest)),
      Buffer.byteLength(JSON.stringify(this.index)),
    );
  }
  private async assertDirectoryBudget(force = false): Promise<void> {
    // Tracked data/metadata caps apply every batch. Physical inventory (including bootstrap
    // and unknown files) is amortized; the declared 192MiB envelope reserves room above
    // 128MiB data + 16MiB metadata + 8MiB bootstrap and one bounded commit's temporaries.
    if (
      this.knownBytes() + this.directoryOverheadBytes >
      this.limits.directoryBytes
    )
      throw new Error(
        "Development log directory byte limit reached. Unknown files were preserved.",
      );
    if (!force && this.now() - this.lastDirectoryAudit < 10_000) return;
    let bytes = 0,
      entries = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      if ((entries += children.length) > 20_000)
        throw new Error("Development log directory entry limit reached.");
      for (const child of children) {
        const file = path.join(directory, child.name);
        let info;
        try {
          info = await lstat(file);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        if (info.isSymbolicLink())
          throw new Error("Development log directory contains a linked path.");
        if (info.isFile()) bytes += info.size;
        else if (
          info.isDirectory() &&
          depth < 3 &&
          (uuid.test(child.name) || child.name === "bootstrap")
        )
          await visit(file, depth + 1);
        else if (info.isDirectory())
          throw new Error(
            "Development log directory contains an unknown child directory.",
          );
        else
          throw new Error("Development log directory contains a special file.");
        if (bytes > this.limits.directoryBytes)
          throw new Error(
            "Development log directory byte limit reached. Unknown files were preserved.",
          );
      }
    };
    await visit(this.directory, 0);
    this.lastDirectoryAudit = this.now();
    this.directoryOverheadBytes = Math.max(0, bytes - this.knownBytes());
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.writes;
    if (this.closed) return;
    this.closed = true;
    try {
      const m = this.manifests.get(this.control.runtimeSessionId);
      if (m && !this.failed) {
        this.applyPendingDrops(m);
        m.run = {
          ...m.run,
          status: "stopped",
          endedAt: this.stamp(),
          heartbeatAt: this.stamp(),
        };
        this.dirty.add(m.run.runtimeSessionId);
        await this.publish();
      }
    } finally {
      this.lock?.close();
      this.lock = undefined;
    }
  }
  /** Best effort from the last published manifest; never publish mutated partial batch state. */
  async fail(): Promise<void> {
    this.failed = true;
    if (!this.lock) return;
    try {
      await this.lock.assertOwned();
      const manifest = await manifestAt(
        this.directory,
        this.control.runtimeSessionId,
      );
      manifest.run = {
        ...manifest.run,
        status: "failed",
        heartbeatAt: this.stamp(),
        gaps: [
          ...manifest.run.gaps.slice(-63),
          {
            reason: "storage",
            at: this.stamp(),
            message:
              "Development log persistence failed. Cached evidence may be incomplete.",
          },
        ],
      };
      await writeLogJson(
        path.join(
          this.directory,
          this.control.runtimeSessionId,
          "manifest.json",
        ),
        manifest,
      );
    } catch {
      /* An unwritable cache remains visibly disconnected after its last heartbeat. */
    } finally {
      this.lock.close();
      this.lock = undefined;
    }
  }
}

function scope(query: DevelopmentLogQuery, runId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runId,
        resources: [...(query.resourceIds ?? [])].sort(),
        route: query.routeId,
        search: query.search,
        level: query.level,
        stream: query.stream,
        kind: query.kind,
        reserveKinds: query.reserveKinds
          ? [...query.reserveKinds].sort()
          : undefined,
      }),
    )
    .digest("hex");
}
interface Cursor {
  version: 1;
  scope: string;
  runId: string;
  position: number;
  highWater: number;
  direction: "older" | "newer";
}
function encodeCursor(value: Cursor, key: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}
const queryError = (message: string): Error & { status: number } =>
  Object.assign(new Error(message), { status: 400 });
function decodeCursor(value: string, key: string): Cursor {
  try {
    if (typeof value !== "string" || value.length > 2048)
      throw queryError("Invalid log cursor.");
    const [body, signature, ...extra] = value.split("."),
      expected = createHmac("sha256", key)
        .update(body ?? "")
        .digest("base64url");
    const supplied = Buffer.from(signature ?? ""),
      expectedBytes = Buffer.from(expected);
    if (
      extra.length ||
      !body ||
      !signature ||
      supplied.length !== expectedBytes.length ||
      !timingSafeEqual(supplied, expectedBytes)
    )
      throw queryError("Invalid log cursor.");
    const cursor = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as Cursor;
    if (
      !cursor ||
      cursor.version !== 1 ||
      !uuid.test(cursor.runId) ||
      !Number.isSafeInteger(cursor.position) ||
      !Number.isSafeInteger(cursor.highWater) ||
      !["older", "newer"].includes(cursor.direction)
    )
      throw queryError("Invalid log cursor.");
    return cursor;
  } catch {
    throw queryError("Invalid log cursor.");
  }
}

const validText = (value: unknown, limit = 1024): value is string =>
  typeof value === "string" &&
  value.length <= limit &&
  !/[\u0000-\u001f]/.test(value);
const validTime = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const safeMetadataText = (value: string, limit = 256): string =>
  (
    sanitizeDevelopmentObservation({
      resourceId: "resource:cache",
      kind: "cache.metadata",
      message: value,
    }).message ?? "[omitted]"
  ).slice(0, limit);
function safeRun(value: DevelopmentLogRun): DevelopmentLogRun {
  if (
    !value ||
    !uuid.test(value.runtimeSessionId) ||
    !validText(value.repositoryKey, 128) ||
    !validText(value.composeProject, 128) ||
    !validText(value.bindingId, 256) ||
    !validText(value.declarationDigest, 256) ||
    !validTime(value.startedAt) ||
    (value.endedAt !== undefined && !validTime(value.endedAt)) ||
    (value.heartbeatAt !== undefined && !validTime(value.heartbeatAt)) ||
    !["collecting", "stopped", "failed"].includes(value.status) ||
    !Number.isSafeInteger(value.dropped) ||
    value.dropped < 0 ||
    !Number.isSafeInteger(value.truncated) ||
    value.truncated < 0 ||
    !Array.isArray(value.gaps) ||
    value.gaps.length > 64 ||
    !value.binding ||
    typeof value.binding !== "object"
  )
    throw new Error("Invalid development log run metadata.");
  const gaps: DevelopmentLogGap[] = value.gaps.map((gap) => {
    if (
      !gap ||
      ![
        "retention",
        "dropped",
        "restart",
        "storage",
        "truncated",
        "source-unavailable",
      ].includes(gap.reason) ||
      !validTime(gap.at) ||
      !validText(gap.message, 4096) ||
      (gap.resourceId !== undefined && !validText(gap.resourceId)) ||
      (gap.count !== undefined &&
        (!Number.isSafeInteger(gap.count) || gap.count < 0))
    )
      throw new Error("Invalid development log gap metadata.");
    return {
      reason: gap.reason,
      at: gap.at,
      message: safeMetadataText(gap.message, 1024),
      ...(gap.resourceId
        ? { resourceId: safeMetadataText(gap.resourceId, 1024) }
        : {}),
      ...(gap.count === undefined ? {} : { count: gap.count }),
    };
  });
  return {
    runtimeSessionId: value.runtimeSessionId,
    repositoryKey: safeMetadataText(value.repositoryKey, 128),
    composeProject: safeMetadataText(value.composeProject, 128),
    bindingId: safeMetadataText(value.bindingId),
    declarationDigest: safeMetadataText(value.declarationDigest),
    startedAt: value.startedAt,
    ...(value.endedAt ? { endedAt: value.endedAt } : {}),
    ...(value.heartbeatAt ? { heartbeatAt: value.heartbeatAt } : {}),
    status: value.status,
    dropped: value.dropped,
    truncated: value.truncated,
    gaps,
    binding: {
      ...(validText(value.binding.deployment, 128)
        ? { deployment: safeMetadataText(value.binding.deployment, 128) }
        : {}),
      ...(validText(value.binding.region, 64)
        ? { region: safeMetadataText(value.binding.region, 64) }
        : {}),
      ...(typeof value.binding.account === "string" &&
      /^\d{12}$/.test(value.binding.account)
        ? { account: value.binding.account }
        : {}),
    },
  };
}

/** Disk bytes are untrusted. Reconstruct every field; never spread a parsed record into a response. */
function safeEvent(
  raw: unknown,
  run: DevelopmentLogRun,
  segment: Segment,
): DevelopmentLogEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as DevelopmentLogEvent;
  if (
    value.schemaVersion !== 1 ||
    value.source !== "development" ||
    value.runtimeSessionId !== run.runtimeSessionId ||
    value.repositoryKey !== run.repositoryKey ||
    value.composeProject !== run.composeProject ||
    value.bindingId !== run.bindingId ||
    value.declarationDigest !== run.declarationDigest ||
    !validText(value.eventId, 160) ||
    !Number.isSafeInteger(value.ingestSequence) ||
    value.ingestSequence < segment.first ||
    value.ingestSequence > segment.last ||
    !value.resource ||
    !validText(value.resource.id) ||
    !validText(value.resource.kind, 80) ||
    !validTime(value.occurredAt) ||
    !validTime(value.observedAt) ||
    !Array.isArray(value.relatedResourceIds) ||
    value.relatedResourceIds.length > 3 ||
    !value.relatedResourceIds.every((id) => validText(id)) ||
    !["debug", "info", "warn", "error"].includes(value.level) ||
    !["event", "stdout", "stderr"].includes(value.stream) ||
    !["resource", "worker", "session", "invocation", "execution"].includes(
      value.attribution,
    ) ||
    !validText(value.kind, 96) ||
    !/^[a-zA-Z0-9_.-]+$/.test(value.kind) ||
    (value.message !== undefined &&
      (typeof value.message !== "string" ||
        Buffer.byteLength(value.message) > defaults.stringBytes)) ||
    !value.producer ||
    !validText(value.producer.component, 64) ||
    !validText(value.producer.instanceId, 160) ||
    (value.producer.workerId !== undefined &&
      !validText(value.producer.workerId, 160)) ||
    (value.producer.containerId !== undefined &&
      !validText(value.producer.containerId, 160))
  )
    return undefined;
  if (
    segment.resourceId === "__overview__"
      ? value.stream !== "event" &&
        value.level !== "error" &&
        value.level !== "warn"
      : value.resource.id !== segment.resourceId &&
        !value.relatedResourceIds.includes(segment.resourceId)
  )
    return undefined;
  const safe = sanitizeDevelopmentObservation({
    resourceId: value.resource.id,
    kind: value.kind,
    relatedResourceIds: value.relatedResourceIds,
    level: value.level,
    stream: value.stream,
    message: value.message,
    details: value.details,
    correlation: value.correlation,
    attribution: value.attribution,
    durationMs: value.durationMs,
    outcome: value.outcome,
    phase: value.phase,
    late: value.late,
    occurredAt: value.occurredAt,
  });
  const { resourceId, ...fields } = safe;
  const priorOmissions = Array.isArray(value.omissions)
    ? value.omissions.slice(0, 32).flatMap((item) =>
        item &&
        validText(item.path, 160) &&
        ["privacy", "size", "depth", "circular", "unsupported"].includes(
          item.reason,
        )
          ? [
              {
                path: safeMetadataText(item.path, 160),
                reason: item.reason,
                ...(Number.isSafeInteger(item.count) && item.count! >= 0
                  ? { count: item.count }
                  : {}),
              },
            ]
          : [],
      )
    : [];
  return {
    ...fields,
    schemaVersion: 1,
    eventId: safeMetadataText(value.eventId, 160),
    source: "development",
    repositoryKey: run.repositoryKey,
    composeProject: run.composeProject,
    runtimeSessionId: run.runtimeSessionId,
    bindingId: run.bindingId,
    declarationDigest: run.declarationDigest,
    resource: {
      id: resourceId,
      kind: safeMetadataText(value.resource.kind, 80),
    },
    observedAt: value.observedAt,
    ingestSequence: value.ingestSequence,
    producer: {
      component: safeMetadataText(value.producer.component, 64),
      instanceId: safeMetadataText(value.producer.instanceId, 160),
      ...(value.producer.workerId
        ? { workerId: safeMetadataText(value.producer.workerId, 160) }
        : {}),
      ...(value.producer.containerId
        ? { containerId: safeMetadataText(value.producer.containerId, 160) }
        : {}),
    },
    omissions: [...priorOmissions, ...safe.omissions].slice(0, 32),
  };
}

export class DevelopmentLogReader {
  constructor(
    readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}
  async runs(): Promise<DevelopmentLogRun[]> {
    const index = await indexAt(this.directory);
    if (!index) return [];
    const result: DevelopmentLogRun[] = [];
    for (const id of index.runs) {
      try {
        const run = safeRun((await manifestAt(this.directory, id)).run);
        if (
          Date.parse(run.startedAt) >= this.now() - defaults.ageMs ||
          run.status === "collecting"
        )
          result.push(run);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return result;
  }
  /** Reads only segments whose primary-record index names this trace; legacy reads stay bounded. */
  async trace(
    query: DevelopmentLogTraceQuery,
  ): Promise<DevelopmentLogTracePage> {
    const observedAt = new Date(this.now()).toISOString();
    const empty: DevelopmentLogTracePage = {
      schemaVersion: 1,
      observedAt,
      traceId: query.traceId,
      complete: false,
      entries: [],
      gaps: [],
      dropped: 0,
      truncated: 0,
      collection: "not-configured",
    };
    if (
      !uuid.test(query.runId) ||
      typeof query.traceId !== "string" ||
      !/^[A-Za-z0-9_.:/-]{1,256}$/.test(query.traceId) ||
      (query.resourceIds !== undefined &&
        (!Array.isArray(query.resourceIds) ||
          query.resourceIds.length > 4 ||
          !query.resourceIds.every((id) => validText(id)))) ||
      (query.routeId !== undefined && !validText(query.routeId)) ||
      (query.limit !== undefined &&
        (!Number.isInteger(query.limit) ||
          query.limit < 1 ||
          query.limit > defaults.pageRecords))
    )
      throw queryError("Invalid development trace query.");
    const index = await indexAt(this.directory);
    if (!index) return empty;
    if (!index.runs.includes(query.runId))
      return {
        ...empty,
        gaps: [
          {
            reason: "retention",
            at: observedAt,
            message: "The requested runtime run has expired.",
          },
        ],
      };
    const manifest = await manifestAt(this.directory, query.runId),
      run = safeRun(manifest.run);
    const candidates = manifest.segments
      .filter(
        (segment) =>
          segment.resourceId !== "__overview__" &&
          (!query.resourceIds?.length ||
            query.resourceIds.includes(segment.resourceId)) &&
          (segment.traceIds === undefined ||
            segment.traceIds.includes(query.traceId)),
      )
      .sort((a, b) => b.last - a.last);
    const entries: DevelopmentLogEvent[] = [],
      seen = new Set<string>(),
      gaps = [...run.gaps];
    let bytes = 0,
      records = 0,
      outputBytes = 0,
      invalid = 0,
      limited = false,
      legacy = false;
    scan: for (const segment of candidates) {
      if (bytes + segment.bytes > defaults.scanBytes) {
        limited = true;
        break;
      }
      bytes += segment.bytes;
      legacy ||= segment.traceIds === undefined;
      let content: string;
      try {
        content = await readLogFile(
          path.join(this.directory, query.runId, segment.file),
          defaults.segmentBytes + defaults.recordBytes,
          segment.bytes,
        );
      } catch (error) {
        if (!missing(error)) throw error;
        invalid++;
        continue;
      }
      if (!content.endsWith("\n")) {
        invalid++;
        continue;
      }
      // Recent records are retained first when a large trace reaches this observation's cap.
      for (const line of content.split("\n").reverse()) {
        if (!line) continue;
        if (++records > defaults.scanRecords) {
          limited = true;
          break scan;
        }
        if (Buffer.byteLength(line) > defaults.recordBytes) {
          invalid++;
          continue;
        }
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          invalid++;
          continue;
        }
        const event = safeEvent(value, run, segment);
        if (!event) {
          invalid++;
          continue;
        }
        if (
          event.correlation.traceId !== query.traceId ||
          seen.has(event.eventId) ||
          (query.routeId &&
            event.resource.id !== query.routeId &&
            !event.relatedResourceIds.includes(query.routeId)) ||
          Date.parse(event.observedAt) < this.now() - defaults.ageMs
        )
          continue;
        const size = Buffer.byteLength(JSON.stringify(event));
        if (
          entries.length >= (query.limit ?? defaults.pageRecords) ||
          outputBytes + size > defaults.pageBytes
        ) {
          limited = true;
          break scan;
        }
        entries.push(event);
        seen.add(event.eventId);
        outputBytes += size;
      }
    }
    if (legacy)
      gaps.push({
        reason: "source-unavailable",
        at: observedAt,
        message:
          "Older cache segments have no trace index; only a bounded legacy scan was available.",
      });
    if (invalid)
      gaps.push({
        reason: "source-unavailable",
        at: observedAt,
        count: invalid,
        message: "Unavailable or invalid cached trace records were omitted.",
      });
    if (limited)
      gaps.push({
        reason: "truncated",
        at: observedAt,
        message:
          "This trace reached its bounded cache read limit. Other trace activity may be outside this observation.",
      });
    return {
      ...empty,
      run,
      entries: entries.sort((a, b) => a.ingestSequence - b.ingestSequence),
      complete: !limited && !legacy && !invalid && !gaps.length,
      gaps: gaps.slice(-64),
      dropped: run.dropped,
      truncated: run.truncated,
      collection:
        run.status === "failed"
          ? "failed"
          : run.status === "stopped"
            ? "stopped"
            : Date.parse(run.heartbeatAt ?? "") < this.now() - 10_000
              ? "disconnected"
              : "collecting",
    };
  }
  async entries(query: DevelopmentLogQuery = {}): Promise<DevelopmentLogPage> {
    const observedAt = new Date(this.now()).toISOString();
    const empty: DevelopmentLogPage = {
      schemaVersion: 1,
      observedAt,
      entries: [],
      gaps: [],
      dropped: 0,
      truncated: 0,
      collection: "not-configured",
    };
    if (
      (query.search !== undefined && !validText(query.search, 128)) ||
      (query.resourceIds !== undefined &&
        (!Array.isArray(query.resourceIds) ||
          query.resourceIds.length > 4 ||
          !query.resourceIds.every((id) => validText(id)))) ||
      (query.limit !== undefined &&
        (!Number.isInteger(query.limit) ||
          query.limit < 1 ||
          query.limit > 200)) ||
      (query.direction !== undefined &&
        !["older", "newer"].includes(query.direction)) ||
      (query.level !== undefined &&
        !["debug", "info", "warn", "error"].includes(query.level)) ||
      (query.stream !== undefined &&
        !["event", "stdout", "stderr"].includes(query.stream)) ||
      (query.kind !== undefined && !validText(query.kind, 96)) ||
      (query.reserveKinds !== undefined &&
        (!Array.isArray(query.reserveKinds) ||
          query.reserveKinds.length < 1 ||
          query.reserveKinds.length > 16 ||
          new Set(query.reserveKinds).size !== query.reserveKinds.length ||
          !query.reserveKinds.every((kind) => validText(kind, 96)) ||
          (query.limit ?? 100) < 2 ||
          query.direction === "newer")) ||
      (query.routeId !== undefined && !validText(query.routeId)) ||
      (query.runId !== undefined && !uuid.test(query.runId))
    )
      throw queryError("Invalid development log query limits.");
    const index = await indexAt(this.directory);
    if (!index) return empty;
    const cursor = query.cursor
      ? decodeCursor(query.cursor, index.cursorKey)
      : undefined;
    const runId = query.runId ?? cursor?.runId ?? index.runs[0];
    if (!runId) return empty;
    if (!index.runs.includes(runId))
      return {
        ...empty,
        gaps: [
          {
            reason: "retention",
            at: observedAt,
            message: "The requested run has expired.",
          },
        ],
      };
    const manifest = await manifestAt(this.directory, runId),
      run = safeRun(manifest.run),
      key = scope(query, runId);
    if (
      cursor &&
      (cursor.scope !== key ||
        cursor.runId !== runId ||
        cursor.position < 0 ||
        cursor.highWater < 0 ||
        (query.direction !== undefined && cursor.direction !== query.direction))
    )
      throw queryError("Log cursor does not belong to this scope.");
    const direction = cursor?.direction ?? query.direction ?? "older",
      highWater =
        direction === "newer"
          ? index.nextSequence - 1
          : (cursor?.highWater ?? index.nextSequence - 1);
    if (query.reserveKinds && direction !== "older")
      throw queryError("Reserved log evidence requires an older read.");
    const position =
      cursor?.position ?? (direction === "older" ? highWater + 1 : 0);
    const resourceIds = [
      ...new Set(
        query.resourceIds?.length ? query.resourceIds : ["__overview__"],
      ),
    ];
    const search = query.search?.toLowerCase();
    const reserveKinds = new Set(query.reserveKinds ?? []);
    const gaps: DevelopmentLogGap[] = [...run.gaps];
    let bytes = 0,
      scanned = 0,
      boundary = position,
      outputBytes = 0,
      limited = false,
      scanLimited = false,
      invalid = 0;
    let reserved = false,
      // A rescued record can be older than omitted matches. Resume at the ordinary
      // retained prefix, never after those omitted records or the rest of the scan.
      retainedBoundary: number | undefined;
    const lanes = resourceIds.map((resourceId) => ({
      resourceId,
      segments: manifest.segments
        .filter(
          (segment) =>
            segment.resourceId === resourceId &&
            (direction === "older"
              ? segment.first < position
              : segment.last > position),
        )
        .sort((a, b) =>
          direction === "older" ? b.last - a.last : a.first - b.first,
        ),
      segmentIndex: 0,
      entries: [] as DevelopmentLogEvent[],
      offset: 0,
    }));
    const loadHead = async (lane: (typeof lanes)[number]): Promise<boolean> => {
      while (
        lane.offset >= lane.entries.length &&
        lane.segmentIndex < lane.segments.length
      ) {
        const segment = lane.segments[lane.segmentIndex]!;
        if (bytes + segment.bytes > defaults.scanBytes) {
          scanLimited = true;
          return false;
        }
        lane.segmentIndex++;
        bytes += segment.bytes;
        let content: string;
        try {
          content = await readLogFile(
            path.join(this.directory, runId, segment.file),
            defaults.segmentBytes + defaults.recordBytes,
            segment.bytes,
          );
        } catch (error) {
          if (!missing(error)) throw error;
          invalid++;
          continue;
        }
        const committed = Buffer.from(content).subarray(0, segment.bytes);
        if (
          committed.byteLength !== segment.bytes ||
          (committed.length && committed[committed.length - 1] !== 10)
        ) {
          invalid++;
          continue;
        }
        lane.entries = [];
        lane.offset = 0;
        for (const line of committed.toString("utf8").split("\n")) {
          if (!line) continue;
          if (Buffer.byteLength(line) > defaults.recordBytes) {
            invalid++;
            continue;
          }
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            invalid++;
            continue;
          }
          const event = safeEvent(value, run, segment);
          if (!event) {
            invalid++;
            continue;
          }
          if (
            event.ingestSequence <= highWater &&
            (direction === "older"
              ? event.ingestSequence < position
              : event.ingestSequence > position)
          )
            lane.entries.push(event);
        }
        lane.entries.sort((a, b) =>
          direction === "older"
            ? b.ingestSequence - a.ingestSequence
            : a.ingestSequence - b.ingestSequence,
        );
      }
      return true;
    };
    const entries: DevelopmentLogEvent[] = [],
      seen = new Set<string>();
    for (;;) {
      if (scanned >= defaults.scanRecords) {
        scanLimited = true;
        limited = true;
        break;
      }
      // Establish every lane's frontier before emitting anything. A later resource segment
      // can overlap an earlier one; advancing a global min/max after scanning one lane skips it.
      let ready = true;
      for (const lane of lanes)
        if (!(await loadHead(lane))) {
          ready = false;
          break;
        }
      if (!ready) {
        limited = true;
        break;
      }
      const lane = lanes
        .filter((item) => item.offset < item.entries.length)
        .sort((a, b) =>
          direction === "older"
            ? b.entries[b.offset]!.ingestSequence -
              a.entries[a.offset]!.ingestSequence
            : a.entries[a.offset]!.ingestSequence -
              b.entries[b.offset]!.ingestSequence,
        )[0];
      if (!lane) break;
      const event = lane.entries[lane.offset]!;
      const matchesFields =
        !seen.has(event.eventId) &&
        Date.parse(event.observedAt) >= this.now() - defaults.ageMs &&
        (!query.level || event.level === query.level) &&
        (!query.stream || event.stream === query.stream) &&
        (!query.kind || event.kind === query.kind) &&
        (!query.routeId ||
          event.resource.id === query.routeId ||
          event.relatedResourceIds.includes(query.routeId));
      const serialized = matchesFields ? JSON.stringify(event) : undefined;
      const matches =
        serialized !== undefined &&
        (!search || serialized.toLowerCase().includes(search));
      const size = matches ? Buffer.byteLength(serialized) : 0;
      const rescue = matches && reserveKinds.has(event.kind);
      if (matches && entries.length >= (query.limit ?? 100)) {
        limited = true;
        if (rescue) {
          do {
            outputBytes -= Buffer.byteLength(JSON.stringify(entries.pop()!));
          } while (entries.length && outputBytes + size > defaults.pageBytes);
          retainedBoundary = entries.at(-1)?.ingestSequence;
        }
      }
      const retain = matches && entries.length < (query.limit ?? 100);
      if (retain && outputBytes + size > defaults.pageBytes) {
        limited = true;
        break;
      }
      lane.offset++;
      scanned++;
      boundary = event.ingestSequence;
      seen.add(event.eventId);
      if (retain) {
        entries.push(event);
        outputBytes += size;
        reserved ||= rescue;
        if (entries.length >= (query.limit ?? 100)) {
          limited = true;
          if (!reserveKinds.size || reserved) break;
          retainedBoundary = event.ingestSequence;
        }
        if (rescue && retainedBoundary !== undefined) break;
      }
    }
    if (retainedBoundary !== undefined) boundary = retainedBoundary;
    if (invalid)
      gaps.push({
        reason: "source-unavailable",
        at: observedAt,
        count: invalid,
        message:
          "Invalid, incomplete or unavailable cached records were omitted.",
      });
    if (scanLimited)
      gaps.push({
        reason: "truncated",
        at: observedAt,
        message:
          "This page reached the bounded cache scan limit. Continue with its cursor for more evidence.",
      });
    const progressed = boundary !== position;
    const nextCursor = encodeCursor(
      {
        version: 1,
        scope: key,
        runId,
        position: direction === "newer" && limited ? boundary : highWater,
        highWater,
        direction: "newer",
      },
      index.cursorKey,
    );
    const olderCursor =
      direction === "older" && limited && progressed
        ? encodeCursor(
            {
              version: 1,
              scope: key,
              runId,
              position: boundary,
              highWater,
              direction: "older",
            },
            index.cursorKey,
          )
        : undefined;
    const oldest = Math.min(
      ...lanes.flatMap((lane) => lane.segments.map((segment) => segment.first)),
    );
    if (
      cursor &&
      cursor.position > 0 &&
      cursor.position < oldest &&
      Number.isFinite(oldest)
    )
      gaps.push({
        reason: "retention",
        at: observedAt,
        message: "The retained history has moved beyond this cursor.",
      });
    return {
      schemaVersion: 1,
      observedAt,
      run,
      entries: direction === "older" ? entries.reverse() : entries,
      olderCursor,
      nextCursor,
      gaps: gaps.slice(-64),
      dropped: run.dropped,
      truncated: run.truncated,
      collection:
        run.status === "failed"
          ? "failed"
          : run.status === "stopped"
            ? "stopped"
            : Date.parse(run.heartbeatAt ?? "") < this.now() - 10_000
              ? "disconnected"
              : "collecting",
    };
  }
}
