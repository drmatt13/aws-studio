import { changedDatabaseInputs, databaseInputsDigest, localDatabaseInputs } from "aws-studio/database/studio-migrations";
import type { Runner, Tools } from "./process";

interface ContainerGeneration { readonly id: string; readonly startedAt: string; readonly finishedAt: string }
const generationFormat = '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}}}';
const REBUILD = "Restart local runtime to rebuild its images, then review any pending local migration in Database.";

/** Bounded per-file identities, or undefined for a record from an older image. */
function recordedInputs(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.length <= 20_000 && entries.every(([file, identity]) => file.length <= 1024 && typeof identity === "string" && /^(?:[a-f0-9]{64}|missing)$/.test(identity))
    ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

/** Names at most three changed inputs; checkout-relative paths carry no private values. */
export function sourceChangedMessage(changed?: readonly string[]): string {
  if (!changed?.length) return `Database source, migration history or dependencies changed after local storage was verified. ${REBUILD}`;
  const named = changed.slice(0, 3).join(", ") + (changed.length > 3 ? ` and ${changed.length - 3} more` : "");
  return `${named} changed after local storage was verified. ${REBUILD}`;
}

/** A successful one-shot proves only its own image inputs and PostgreSQL start.
 * Never reuse it after a git pull, branch switch, or database container restart.
 * This is bounded Docker evidence, not a continuous live-schema inspection.
 */
export class LocalDatabaseReadiness {
  private verified?: { readonly generation: string; readonly digest: string; readonly inputs?: Readonly<Record<string, string>> };

  constructor(private readonly root: string, private readonly tools: Tools, private readonly run: Runner, private readonly env: NodeJS.ProcessEnv) {}

  async problem(postgres: string, prerequisite: string): Promise<string | undefined> {
    const unavailable = "Could not confirm which local PostgreSQL start was verified. Restart local runtime to verify storage before using the application.";
    try {
      if (![postgres, prerequisite].every(name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) return unavailable;
      const inspected = await this.run(this.tools.docker(["inspect", "--format", generationFormat, postgres, prerequisite], this.env), { timeoutMs: 10_000 });
      if (inspected.code !== 0) return unavailable;
      const generations = inspected.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as ContainerGeneration);
      if (generations.length !== 2 || generations.some(item => !/^[a-f0-9]{12,64}$/.test(item.id) || !Number.isFinite(Date.parse(item.startedAt)))) return unavailable;
      const [database, verification] = generations as [ContainerGeneration, ContainerGeneration];
      const verifiedAt = Date.parse(verification.finishedAt);
      if (!Number.isFinite(verifiedAt) || verifiedAt < Date.parse(verification.startedAt)) return unavailable;
      if (Date.parse(database.startedAt) > Date.parse(verification.startedAt)) return "Local PostgreSQL restarted or was recreated after its storage check. Restart local runtime to verify the current database; a new empty volume will initialize automatically.";
      const generation = `${verification.id}:${verification.startedAt}:${verification.finishedAt}`;
      if (this.verified?.generation !== generation) {
        const logs = await this.run(this.tools.docker(["logs", "--since", verification.startedAt, "--tail", "40", prerequisite], this.env), { timeoutMs: 10_000 });
        if (logs.code !== 0) return unavailable;
        const records = logs.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const record = records.filter(item => item?.kind === "result" && item.commandId === "db.prepare-local").slice(-1)[0];
        const preparation = record?.envelope?.result;
        if (record?.envelope?.ok !== true || preparation?.ok !== true || !["initialized", "verified"].includes(preparation.status) || !/^[a-f0-9]{64}$/.test(preparation.inputsDigest ?? "")) return "This local runtime has no current database source verification. Restart local runtime to rebuild the database image and verify the saved contract.";
        const inputs = recordedInputs(preparation.inputs);
        this.verified = { generation, digest: preparation.inputsDigest, ...(inputs ? { inputs } : {}) };
      }
      // Images built before per-file identities can prove only the aggregate digest.
      if (!this.verified.inputs) return databaseInputsDigest(this.root) !== this.verified.digest ? sourceChangedMessage() : undefined;
      const changed = changedDatabaseInputs(this.verified.inputs, localDatabaseInputs(this.root));
      return changed.length ? sourceChangedMessage(changed) : undefined;
    } catch {
      return unavailable;
    }
  }
}
