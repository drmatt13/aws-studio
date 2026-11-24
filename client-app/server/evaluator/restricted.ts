import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Mode, ModeModel } from "../../shared/model";
import type { PreflightRequest, PreflightResult } from "../model/preflight";
import { failedModel } from "../model/project";
import { executionPolicy, type ExecutionPolicy } from "../agent-runtime/policy";
import { runtimeNode } from "../agent-runtime/providers/toolchain";
import { CodexConnection, probeCodexBoundary } from "../agent-runtime/providers/codex";
import { prepareAgentWorkspace } from "aws-studio/source/workspace";
import { linkDependencies } from "aws-studio/source/dependency-links";
export { linkDependencies };
import type { EvaluatorLifetime } from "./pool";
import { readEvaluationArtifact } from "aws-studio/source/result-artifact";
import type { ProjectToolchain } from "aws-studio/cli/project-node.mjs";
import { projectRuntime } from "../project-runtime";
import { EMPTY_INPUT_METADATA } from "./input-metadata";
import { assertProjectHello, PROJECT_CAPABILITIES, PROJECT_PROTOCOL } from "./protocol";

const FRAME_LIMIT = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 55_000;
let bundle: Promise<Uint8Array> | undefined;

/** Compile trusted projection code; authored configuration is loaded only inside the sandbox. */
export function restrictedEvaluatorBundle(): Promise<Uint8Array> {
  return bundle ??= (async () => {
    const entry = fileURLToPath(new URL("./evaluate.ts", import.meta.url));
    const { build } = await import("esbuild");
    const result = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", target: "node24", write: false, logLevel: "silent",
      plugins: [{ name: "one-framework-instance", setup(builder) {
        builder.onResolve({ filter: /^aws-studio\/config$/ }, () => ({ path: "candidate-framework", namespace: "candidate-framework" }));
        builder.onLoad({ filter: /.*/, namespace: "candidate-framework" }, () => ({ contents: "module.exports = require('node:module').createRequire(require('node:path').join(process.cwd(), 'package.json'))('aws-studio/config');", loader: "js" }));
        builder.onResolve({ filter: /packages\/aws-studio\/src\/database-pool$/ }, () => ({ path: "candidate-framework", namespace: "candidate-framework" }));
        // The sandbox has no Studio checkout to redirect from: the candidate's framework is selected above.
        builder.onResolve({ filter: /\/use-project-framework$/ }, () => ({ path: "no-redirect", namespace: "no-redirect" }));
        builder.onLoad({ filter: /.*/, namespace: "no-redirect" }, () => ({ contents: "", loader: "js" }));
      } }],
    });
    if (result.outputFiles?.length !== 1) throw new Error("The restricted evaluator could not be compiled.");
    return result.outputFiles[0]!.contents;
  })();
}

// Trusted one-shot bridge. Authored stdout is suppressed, and native bounded
// buffered output avoids depending on an indefinitely live streaming channel.
const RELAY = `import { createRequire } from 'node:module';
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [entry,root,mode,inputs,requestFile] = process.argv.slice(2);
Object.assign(process.env,{FRAMEWORK_INPUTS_FILE:inputs,FRAMEWORK_MODE:mode,STUDIO_MODE:mode,STUDIO_REPOSITORY_ROOT:root});
const request=JSON.parse(readFileSync(requestFile,'utf8'));
const output=process.stdout.write.bind(process.stdout);
process.stdout.write=()=>true;process.stderr.write=()=>true;
let finished=false;
let hello;
const finish=value=>{if(finished)return;finished=true;const bytes=Buffer.from(JSON.stringify({...value,hello}));if(bytes.length>${FRAME_LIMIT})process.exit(2);writeFileSync(request.resultFile,bytes,{flag:'wx',mode:0o600});output(JSON.stringify({version:1,hash:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})+'\\n',()=>process.exit(0));};
process.send=message=>{
 if(message.type==='hello'){
  if(hello||message.protocol!==${PROJECT_PROTOCOL}||message.version!==request.runtime||!${JSON.stringify(PROJECT_CAPABILITIES)}.every(capability=>message.capabilities?.includes(capability)))process.exit(2);
  hello=message;queueMicrotask(()=>process.emit('message',{type:'load',overrides:request.overrides??{}}));
 }else if(message.type==='conditions')queueMicrotask(()=>process.emit('message',Array.isArray(message.conditions)&&!message.conditions.length?{type:'conditions',outcomes:{}}:{type:'conditions',privateConditionsUnavailable:true}));
 else if(message.type==='model'){
  if(request.preflight)queueMicrotask(()=>process.emit('message',{type:'preflight',id:1,request:request.preflight}));
  else finish(message);
 }else if(message.type==='preflight')finish(message);
 return true;
};
createRequire(import.meta.url)(entry);
setTimeout(()=>process.exit(2),${COMMAND_TIMEOUT_MS}).unref();
`;

export interface RestrictedConnection {
  initialize(): Promise<unknown>;
  request(method: string, params: unknown, timeout?: number): Promise<any>;
  readonly transport: { readonly closed: Promise<unknown>; stop(): void; };
}
interface Prepared { readonly policy: ExecutionPolicy; readonly command: string[]; readonly sourceRoot?: string; readonly requestFile: (value: unknown) => string; readonly readResult?: (receipt: unknown) => string; readonly cleanup: () => void; }
/** Dependency injection is for disposable protocol tests; no HTTP/environment bypass exists. */
export interface RestrictedEvaluatorDependencies {
  readonly prepare?: (root: string, mode: Mode) => Promise<Prepared>;
  readonly connect?: (policy: ExecutionPolicy, receive: (message: Record<string, any>) => Promise<void>) => RestrictedConnection;
  readonly probe?: (connection: RestrictedConnection, policy: ExecutionPolicy) => Promise<void>;
}

async function prepare(root: string, mode: Mode, toolchain: ProjectToolchain): Promise<Prepared> {
  root = realpathSync(root);
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-restricted-evaluation-")));
  try {
    const runtime = path.join(directory, "runtime"), scratch = path.join(directory, "scratch");
    mkdirSync(runtime, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
    const entry = path.join(runtime, "evaluate.cjs"), relay = path.join(runtime, "relay.mjs"), inputs = path.join(runtime, "inputs.env");
    writeFileSync(entry, await restrictedEvaluatorBundle(), { flag: "wx", mode: 0o400 });
    writeFileSync(relay, RELAY, { flag: "wx", mode: 0o400 });
    writeFileSync(inputs, `PROD_DEPLOYMENT=${mode === "prod" ? "true" : "false"}\n`, { flag: "wx", mode: 0o400 });
    // A native macOS profile for thousands of exact source paths can exceed
    // sandbox-exec's argv limit. Copy only public captured source instead of
    // widening read access to a live directory containing private inputs.
    const workspace = await prepareAgentWorkspace(root, { storageDirectory: path.join(directory, "capture"), copyDependencies: false });
    const sourceRoot = workspace.workingDirectory;
    const dependencies = linkDependencies(root, sourceRoot, Object.keys(workspace.baseline.files).map(name => path.join(root, name)));
    const loader = realpathSync(createRequire(path.join(sourceRoot, "package.json")).resolve("tsx"));
    const policy = executionPolicy(sourceRoot, scratch, { readOnlyCwd: true, readPaths: [runtime, ...dependencies], toolchain });
    const node = runtimeNode(policy.runtimeDirectory);
    let resultFile: string | undefined;
    return { policy, sourceRoot, command: [node, "--import", pathToFileURL(loader).href, relay, entry, sourceRoot, mode, inputs], requestFile: value => {
      resultFile = path.join(scratch, `result-${randomUUID()}.json`);
      const file = path.join(runtime, `request-${randomUUID()}.json`); writeFileSync(file, JSON.stringify({ ...value as object, resultFile, runtime: toolchain.version }), { flag: "wx", mode: 0o400 }); return file;
    }, readResult: receipt => { if (!resultFile) throw new Error("No requested evaluation artifact."); return readEvaluationArtifact(resultFile, receipt); }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

/** A retained public-source capture; each model/preflight uses a finite sandbox command. */
export class RestrictedEvaluator {
  readonly model: Promise<ModeModel>;
  inputs = EMPTY_INPUT_METADATA;
  private connection?: RestrictedConnection;
  private prepared?: Prepared;
  private readonly launch: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private modelResolve!: (model: ModeModel) => void;
  private readonly began = Date.now();
  private modelTimer?: NodeJS.Timeout;
  private closed = false;
  private disposal?: Promise<void>;
  private readonly repositoryRoot: string;

  constructor(readonly mode: Mode, root: string, private readonly log: (line: string) => void = () => {}, private readonly overrides: Readonly<Record<string, string>> = {}, private readonly lifetime?: EvaluatorLifetime, private readonly dependencies: RestrictedEvaluatorDependencies = {}, private readonly toolchain?: ProjectToolchain) {
    this.repositoryRoot = root; lifetime?.assertOpen();
    this.model = new Promise(resolve => { this.modelResolve = resolve; });
    lifetime?.retain(this);
    this.modelTimer = setTimeout(() => { this.fail("Restricted source evaluation timed out. No privileged fallback was run."); void this.dispose(); }, 60_000);
    this.launch = this.start().catch(error => { log(`Restricted source evaluation failed: ${error instanceof Error ? error.message.slice(0, 1000) : "unknown setup failure"}`); this.fail("Restricted source evaluation is unavailable. Install a compatible Codex sandbox and refresh; privileged evaluation is disabled for this checkout."); })
      .finally(() => { if (this.modelTimer) clearTimeout(this.modelTimer); });
  }
  private async start(): Promise<void> {
    this.prepared = await (this.dependencies.prepare
      ? this.dependencies.prepare(this.repositoryRoot, this.mode)
      : prepare(this.repositoryRoot, this.mode, this.toolchain ?? projectRuntime(this.repositoryRoot)));
    if (this.closed) return;
    const value = await this.execute({ overrides: this.translate(this.overrides, true) });
    const model = value?.model;
    if (value?.type !== "model" || !model || model.mode !== this.mode || !["ok", "error"].includes(model.status) || !Array.isArray(model.targets) || !Array.isArray(model.diagnostics)) throw new Error("Invalid restricted model.");
    this.inputs = value.inputs ?? EMPTY_INPUT_METADATA;
    if (value.hello) this.log(`[${this.mode}] Restricted project evaluator protocol ${value.hello.protocol} running Node ${value.hello.version} (${value.hello.node}).`);
    this.modelResolve(this.translate(model, false) as ModeModel);
  }
  private async execute(payload: unknown): Promise<any> {
    if (this.closed || !this.prepared) throw new Error("Restricted evaluation is closed.");
    const { policy, command, requestFile } = this.prepared;
    const file = requestFile(payload);
    const connection = (this.dependencies.connect ?? ((value, receive) => new CodexConnection(value, receive, { isolatedConfig: true })))(policy, async () => {});
    this.connection = connection;
    let result: any;
    try {
      await connection.initialize();
      await (this.dependencies.probe ?? ((value, profile) => probeCodexBoundary(value as CodexConnection, profile)))(connection, policy);
      if (this.closed) throw new Error("Restricted evaluation was cancelled.");
      result = await connection.request("command/exec", { command: [...command, file], cwd: policy.cwd, permissionProfile: policy.profile, env: policy.commandEnvironment,
        timeoutMs: COMMAND_TIMEOUT_MS, outputBytesCap: FRAME_LIMIT }, COMMAND_TIMEOUT_MS + 5000);
      if (result.exitCode !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > FRAME_LIMIT) throw new Error("Restricted command did not return a complete result.");
    } finally {
      connection.transport.stop(); await connection.transport.closed;
      if (this.connection === connection) this.connection = undefined;
    }
    const receipt = JSON.parse(result.stdout);
    if (!this.prepared.readResult) return receipt;
    const value = JSON.parse(this.prepared.readResult(receipt));
    assertProjectHello(value?.hello, (this.toolchain ?? projectRuntime(this.repositoryRoot)).version);
    return value;
  }
  private translate(value: unknown, toCopy: boolean): unknown {
    const from = toCopy ? this.repositoryRoot : this.prepared?.sourceRoot, to = toCopy ? this.prepared?.sourceRoot : this.repositoryRoot;
    if (!from || !to) return value;
    const text = (item: string): string => item === from ? to : item.startsWith(`${from}${path.sep}`) ? to + item.slice(from.length) : item;
    const visit = (item: unknown): unknown => typeof item === "string" ? text(item) : Array.isArray(item) ? item.map(visit) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [text(key), visit(entry)])) : item;
    return visit(value);
  }
  private fail(message: string): void { this.modelResolve(failedModel(this.mode, new Error(message), Date.now() - this.began)); }
  async preflight(request: PreflightRequest): Promise<PreflightResult> {
    await this.launch;
    const operation = this.queue.then(async (): Promise<PreflightResult> => {
      if (this.closed || !this.prepared) throw new Error("Restricted evaluation is closed.");
      const value = await this.execute({ overrides: this.translate(this.overrides, true), preflight: this.translate(request, true) });
      const result = value?.result;
      if (value?.type !== "preflight" || !result || result.mode !== this.mode || typeof result.ok !== "boolean" || !Array.isArray(result.diagnostics)) throw new Error("Invalid restricted preflight result.");
      return this.translate(result, false) as PreflightResult;
    });
    this.queue = operation.catch(() => {});
    return operation.catch(() => ({ mode: this.mode, ok: false, diagnostics: [{ severity: "error", stage: "load", message: "Restricted preflight is unavailable. Refresh before reviewing source; no privileged fallback was run." }] }));
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true; this.fail("The restricted evaluator was stopped."); this.connection?.transport.stop();
    return this.disposal = (async () => {
      await this.launch; await this.queue;
      this.prepared?.cleanup(); this.lifetime?.release(this);
    })();
  }
}
