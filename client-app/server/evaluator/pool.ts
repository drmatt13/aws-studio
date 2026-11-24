import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Mode, ModeModel } from "../../shared/model";
import { resolveDeployOutcomes } from "../inputs";
import type { PreflightRequest, PreflightResult } from "../model/preflight";
import { failedModel } from "../model/project";
import { withCatalogContext } from "../model/catalog-context";
import { restrictedSourceEvaluationRequired } from "aws-studio/source/source-gate";
import { RestrictedEvaluator } from "./restricted";
import { projectRuntime } from "../project-runtime";
import type { ProjectToolchain } from "aws-studio/cli/project-node.mjs";
import { EMPTY_INPUT_METADATA, type InputMetadata } from "./input-metadata";
import { assertProjectHello } from "./protocol";
import { launchInspection } from "./inspection-process";

/**
 * The dev and prod evaluators, kept alive between questions and replaced
 * whenever the source changes.
 *
 * Each is a fresh project Node process, so a reload is a new module
 * graph rather than a cache to invalidate. A process that hangs or dies is
 * reported as a failed model, never as a stale one.
 */

const EVALUATOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "evaluate.ts");
const LOAD_TIMEOUT_MS = 60_000;
const PREFLIGHT_TIMEOUT_MS = 30_000;
const DISPOSE_GRACE_MS = 1_000;

interface Pending {
  readonly resolve: (result: PreflightResult) => void;
  readonly timer: NodeJS.Timeout;
}

/** One Studio owner's active evaluators, including short-lived review pools. */
export class EvaluatorLifetime {
  private readonly evaluators = new Set<{ dispose(): Promise<void> }>();
  private closed = false;
  private disposal: Promise<void> | undefined;

  assertOpen(): void { if (this.closed) throw new Error("The Studio evaluator lifetime is closed."); }
  retain(evaluator: { dispose(): Promise<void> }): void { this.assertOpen(); this.evaluators.add(evaluator); }
  release(evaluator: { dispose(): Promise<void> }): void { this.evaluators.delete(evaluator); }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = Promise.all([...this.evaluators].map(evaluator => evaluator.dispose())).then(() => undefined);
    return this.disposal;
  }
}

class Evaluator {
  private child: ChildProcess | undefined;
  private disposal: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  readonly model: Promise<ModeModel>;
  inputs = EMPTY_INPUT_METADATA;

  constructor(
    readonly mode: Mode,
    repositoryRoot: string,
    log: (line: string) => void,
    overrides: Readonly<Record<string, string>> = {},
    lifetime?: EvaluatorLifetime,
    runtime = projectRuntime(repositoryRoot),
    conditionInputRoot = repositoryRoot,
  ) {
    lifetime?.assertOpen();
    this.model = new Promise<ModeModel>((resolve) => {
      const started = Date.now();
      const directory = mkdtempSync(path.join(tmpdir(), "studio-evaluation-"));
      const inputs = path.join(directory, "inputs.env");
      const cleanup = () => rmSync(directory, { recursive: true, force: true });
      let child: ChildProcess;
      try {
        writeFileSync(inputs, `PROD_DEPLOYMENT=${mode === "prod"}\n`, { flag: "wx", mode: 0o600 });
        child = launchInspection(EVALUATOR, repositoryRoot, runtime, {
          ...process.env,
          FRAMEWORK_INPUTS_FILE: inputs,
          FRAMEWORK_MODE: mode,
          STUDIO_MODE: mode,
        });
      } catch (error) { cleanup(); throw error; }
      this.child = child;
      lifetime?.retain(this);
      child.once("close", () => { cleanup(); lifetime?.release(this); });
      const relay = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) log(`[${mode}] ${line}`);
      };
      child.stdout?.on("data", relay);
      child.stderr?.on("data", relay);
      const timer = setTimeout(() => {
        resolve(failedModel(mode, new Error(`The ${mode} evaluation did not finish within ${LOAD_TIMEOUT_MS / 1000}s.`), Date.now() - started));
        child.kill();
      }, LOAD_TIMEOUT_MS);
      let negotiated = false;
      child.on("message", (message: { type?: string; id?: number; model?: ModeModel; result?: PreflightResult; inputs?: InputMetadata; conditions?: import("aws-studio/config").DeployCondition[] }) => {
        if (!negotiated) {
          try {
            assertProjectHello(message, runtime.version);
            if (message.node !== runtime.node) throw new Error("The evaluator reported a different Node executable from the selected project runtime.");
            negotiated = true;
            log(`[${mode}] Project evaluator protocol ${message.protocol} running Node ${message.version} (${message.node}).`);
            child.send({ type: "load", overrides });
          } catch (error) {
            resolve(failedModel(mode, error, Date.now() - started));
            void this.dispose();
          }
        } else if (message.type === "conditions" && message.conditions) {
          try { child.send({ type: "conditions", outcomes: resolveDeployOutcomes(conditionInputRoot, message.conditions) }); }
          catch (error) { child.send({ type: "conditions", error: error instanceof Error ? error.message : "Unable to resolve deployment conditions." }); }
        } else if (message.type === "model" && message.model) {
          this.inputs = message.inputs ?? EMPTY_INPUT_METADATA;
          clearTimeout(timer);
          resolve(message.model);
        } else if (message.type === "preflight" && typeof message.id === "number" && message.result) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message.result);
        }
      });
      child.once("error", error => {
        clearTimeout(timer);
        resolve(failedModel(mode, error, Date.now() - started));
        if (child.pid === undefined) this.child = undefined;
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve(failedModel(mode, new Error(`The ${mode} evaluator exited (${signal ?? `code ${code}`}) before answering.`), Date.now() - started));
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.resolve({ mode, ok: false, diagnostics: [{ severity: "error", stage: "load", message: "The evaluator exited before answering." }] });
          this.pending.delete(id);
        }
        this.child = undefined;
      });
    });
  }

  preflight(request: PreflightRequest): Promise<PreflightResult> {
    const child = this.child;
    if (!child?.connected) {
      return Promise.resolve({ mode: this.mode, ok: false, diagnostics: [{ severity: "error", stage: "load", message: "The evaluator is not running." }] });
    }
    const id = this.nextId++;
    return new Promise<PreflightResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ mode: this.mode, ok: false, diagnostics: [{ severity: "error", stage: "validate", message: `The ${this.mode} preflight did not answer within ${PREFLIGHT_TIMEOUT_MS / 1000}s.` }] });
      }, PREFLIGHT_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      child.send({ type: "preflight", id, request });
    });
  }

  /** Stops the process, resolving once it has exited. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    this.disposal = new Promise<void>((resolve) => {
      // Authored configuration can register SIGTERM and then block the event
      // loop. Bound disposal of this exact owned child even in that case.
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, DISPOSE_GRACE_MS);
      timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.disconnect();
      child.kill();
    });
    return this.disposal;
  }
}

export interface Evaluation {
  readonly dev: ModeModel;
  readonly prod: ModeModel;
  readonly preflight: (request: PreflightRequest) => Promise<{ readonly dev: PreflightResult; readonly prod: PreflightResult }>;
  readonly inputMetadata?: Readonly<Record<Mode, InputMetadata>>;
}

/** Starts a dev and a prod evaluator and waits for both models. */
export class EvaluatorPool {
  private current: { dev: Evaluator | RestrictedEvaluator; prod: Evaluator | RestrictedEvaluator } | undefined;

  constructor(
    private readonly repositoryRoot: string,
    private readonly log: (line: string) => void = () => {},
    private readonly lifetime?: EvaluatorLifetime,
    private readonly runtime?: ProjectToolchain,
    private readonly conditionInputRoot = repositoryRoot,
  ) {}

  async evaluate(overrides: Readonly<Record<string, string>> = {}): Promise<Evaluation> {
    void this.dispose();
    // The importer sets this durable requirement before the first replacement.
    // Failed sandbox setup never falls back to privileged evaluation.
    const runtime = this.runtime ?? projectRuntime(this.repositoryRoot);
    const restricted = restrictedSourceEvaluationRequired(this.conditionInputRoot);
    const start = (mode: Mode) => restricted
      ? new RestrictedEvaluator(mode, this.repositoryRoot, this.log, overrides, this.lifetime, {}, runtime)
      : new Evaluator(mode, this.repositoryRoot, this.log, overrides, this.lifetime, runtime, this.conditionInputRoot);
    const pair = {
      dev: start("dev"),
      prod: start("prod"),
    };
    this.current = pair;
    const [dev, prod] = await Promise.all([pair.dev.model, pair.prod.model]);
    return {
      dev: withCatalogContext(dev, prod),
      prod: withCatalogContext(prod, dev),
      inputMetadata: { dev: pair.dev.inputs, prod: pair.prod.inputs },
      preflight: async (request) => {
        const [devResult, prodResult] = await Promise.all([pair.dev.preflight(request), pair.prod.preflight(request)]);
        return { dev: devResult, prod: prodResult };
      },
    };
  }

  /** Stops both evaluators, resolving once both have exited. */
  dispose(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    return current ? Promise.all([current.dev.dispose(), current.prod.dispose()]).then(() => undefined) : Promise.resolve();
  }
}
