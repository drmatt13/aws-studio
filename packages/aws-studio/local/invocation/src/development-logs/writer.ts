import path from "node:path";
import {
  DevelopmentLogStore,
  DevelopmentLogReader,
  readLogFile,
  writeLogJson,
} from "aws-studio/local/development-logs";
import {
  DEVELOPMENT_FOLLOWER_CHECKPOINT_BYTES,
  validateDevelopmentFollowerCheckpoint,
} from "./checkpoint";
import type { DevelopmentLogControl } from "aws-studio/development-logs";
import type { DevelopmentLogBatchEntry } from "aws-studio/local/development-logs";

let store: DevelopmentLogStore | undefined;
let work = Promise.resolve();
let bootstrap: DevelopmentLogReader | undefined;
let bootstrapCursor: string | undefined;
let runId: string | undefined;
let checkpointDirectory: string | undefined;
let checkpointControl: DevelopmentLogControl | undefined;
async function importStartup(): Promise<void> {
  if (!bootstrap || !store || !runId) return;
  let page: Awaited<ReturnType<DevelopmentLogReader["entries"]>>;
  try {
    page = await bootstrap.entries({
      runId,
      resourceIds: ["runtime:development"],
      direction: "newer",
      limit: 32,
      cursor: bootstrapCursor,
    });
  } catch {
    // A startup spool may still be publishing its first manifest. Retry the next heartbeat.
    return;
  }
  if (page.entries.length)
    await store.append(
      page.entries.map(({ resource, eventId, producer, ...fields }) => ({
        eventId,
        producer,
        observation: { ...fields, resourceId: resource.id },
      })),
    );
  bootstrapCursor = page.nextCursor;
}
process.on(
  "message",
  (message: {
    type: string;
    directory?: string;
    control?: DevelopmentLogControl;
    entries?: DevelopmentLogBatchEntry[];
    dropped?: number;
    requestId?: string;
    value?: unknown;
  }) => {
    work = work
      .then(async () => {
        if (
          message.type === "initialize" &&
          message.directory &&
          message.control &&
          !store
        ) {
          store = new DevelopmentLogStore(message.directory, message.control);
          await store.initialize();
          runId = message.control.runtimeSessionId;
          checkpointDirectory = message.directory;
          checkpointControl = message.control;
          bootstrap = new DevelopmentLogReader(
            path.join(message.directory, "bootstrap"),
          );
          await importStartup();
          process.send?.({ type: "ready" });
        } else if (
          (message.type === "checkpoint.load" ||
            message.type === "checkpoint.save") &&
          checkpointDirectory &&
          checkpointControl &&
          typeof message.requestId === "string"
        ) {
          try {
            const file = path.join(checkpointDirectory, "followers.json");
            let value: unknown;
            if (message.type === "checkpoint.load") {
              try {
                value = validateDevelopmentFollowerCheckpoint(
                  JSON.parse(
                    await readLogFile(
                      file,
                      DEVELOPMENT_FOLLOWER_CHECKPOINT_BYTES,
                    ),
                  ),
                  checkpointControl,
                );
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
            } else {
              value = validateDevelopmentFollowerCheckpoint(
                message.value,
                checkpointControl,
              );
              if (!value)
                throw new Error("Invalid follower checkpoint metadata.");
              await writeLogJson(file, value);
            }
            process.send?.({
              type: "checkpoint.result",
              requestId: message.requestId,
              value,
            });
          } catch {
            process.send?.({
              type: "checkpoint.error",
              requestId: message.requestId,
            });
          }
        } else if (message.type === "append" && store) {
          if (message.dropped) store.drop(message.dropped);
          await store.append(message.entries ?? []);
          await importStartup();
          process.send?.({ type: "committed" });
        } else if (message.type === "close") {
          if (message.dropped) store?.drop(message.dropped);
          await importStartup();
          await store?.close();
          process.send?.({ type: "closed" });
          process.disconnect();
        }
      })
      .catch(async (error: unknown) => {
        await store?.fail().catch(() => {});
        const candidate =
          (error as { code?: unknown; name?: unknown })?.code ??
          (error as { name?: unknown })?.name;
        const code =
          typeof candidate === "string" &&
          [
            "ENOENT",
            "EACCES",
            "EPERM",
            "ENOSPC",
            "EIO",
            "SQLITE_BUSY",
            "ERR_SQLITE_ERROR",
            "ERR_MODULE_NOT_FOUND",
            "ERR_UNKNOWN_BUILTIN_MODULE",
            "SyntaxError",
            "TypeError",
            "Error",
          ].includes(candidate)
            ? candidate
            : "storage-error";
        process.send?.({ type: "failed", code }, () => process.disconnect());
      });
  },
);
// An orphaned writer has no authority to keep appending after its owner exits.
process.once("disconnect", () => {
  void work.finally(() => process.exit(0));
});
