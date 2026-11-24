import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Kind, parse } from "graphql";
import type { GraphQLClientInventory, GraphQLDocument, GraphQLExecution, GraphQLRuntime } from "../../../shared/graphql-workspace";
import { graphqlWorkspaceApi } from "../../graphql-workspace-api";
import { Compass, Play, RefreshCw } from "lucide-react";
import type { ChainStatus } from "../../graphql-chain";
import { Button } from "../../ui/Button";
import { Select, Textarea, TextInput } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";
import { documentProseClasses, documentSupportClasses, documentCardTitleClasses } from "../DocumentUI";
import { WorkbenchPageHeader, WorkbenchStatusHeading, workbenchCardClasses, workbenchPageClasses } from "../WorkbenchUI";
import { ChainStatusIcon } from "./ChainStatusIcon";
import { graphqlPreClasses } from "./GraphQLChainDetails";

export interface PreparedGraphQLDocument { readonly id: string; readonly document: GraphQLDocument }

function variablesObject(source: string): { value?: Record<string, unknown>; error?: string } {
  try { const value: unknown = JSON.parse(source); return value && typeof value === "object" && !Array.isArray(value) ? { value: value as Record<string, unknown> } : { error: "Variables must be a JSON object." }; }
  catch { return { error: "Variables must be valid JSON." }; }
}

const fieldClasses = "grid min-w-0 gap-1 text-label";

/** The local API's readiness in the shared status shapes: a word for the heading, the server's sentence below. */
function runtimeStatus(checking: boolean, error: string | undefined, runtime: GraphQLRuntime | undefined): { readonly status: ChainStatus; readonly message: string } {
  if (checking) return { status: { label: "Checking", shape: "checking", tone: "quiet" }, message: "Checking local API readiness…" };
  if (error !== undefined) return { status: { label: "Unavailable", shape: "unknown", tone: "quiet" }, message: error };
  if (!runtime) return { status: { label: "Unavailable", shape: "unknown", tone: "quiet" }, message: "Local API unavailable." };
  const label = { ready: "Ready", starting: "Starting", stopped: "Stopped", blocked: "Blocked", unavailable: "Unavailable" }[runtime.status];
  const status: ChainStatus = runtime.status === "ready" ? { label, shape: "passed", tone: "accept" }
    : runtime.status === "starting" ? { label, shape: "checking", tone: "quiet" }
    : { label, shape: "attention", tone: "caution" };
  return { status, message: runtime.message };
}

/** Credentials and execution results belong only to this mounted browser component. */
export function GraphQLExplorer({ client, repositoryRoot, visible, prepared }: { readonly client: GraphQLClientInventory; readonly repositoryRoot: string; readonly visible: boolean; readonly prepared?: PreparedGraphQLDocument }) {
  const [source, setSource] = useState(""), [variables, setVariables] = useState("{}"), [operation, setOperation] = useState("");
  const [operationName, setOperationName] = useState("");
  const [idToken, setIdToken] = useState(""), [confirmation, setConfirmation] = useState<"unconfirmed" | "confirmed">("unconfirmed");
  const [result, setResult] = useState<GraphQLExecution>(), [problem, setProblem] = useState<string>(), [pending, setPending] = useState<"idle" | "running">("idle");
  const controller = useRef<AbortController | undefined>(undefined);
  const runtime = useQuery({ queryKey: ["graphql-runtime", repositoryRoot], queryFn: ({ signal }) => graphqlWorkspaceApi.runtime(signal), enabled: visible, retry: false, refetchInterval: visible ? 10_000 : false, refetchOnWindowFocus: true });
  const operations = client.documents.filter(document => ["query", "mutation"].includes(document.kind) && document.executableSource);
  const load = (document: GraphQLDocument) => { setSource(document.executableSource ?? document.source); setOperation(document.id); setOperationName(document.name); setVariables("{}"); setResult(undefined); setProblem(undefined); setConfirmation("unconfirmed"); };
  const preparedId = prepared?.id;
  useEffect(() => { if (prepared) load(prepared.document); }, [preparedId]);
  useEffect(() => () => controller.current?.abort(), []);
  const parsed = variablesObject(variables);
  const authored = useMemo(() => {
    if (!source.trim()) return { error: "Enter an operation document.", kind: undefined };
    try {
      const definitions = parse(source).definitions.filter(definition => definition.kind === Kind.OPERATION_DEFINITION);
      const definition = operationName.trim() ? definitions.find(item => item.name?.value === operationName.trim()) : definitions.length === 1 ? definitions[0] : undefined;
      if (!definition) return { error: operationName.trim() ? "The operation name was not found in this document." : "Choose an operation name when the document contains multiple operations.", kind: undefined };
      if (definition.operation === "subscription") return { error: "Subscriptions are not supported in this Explorer.", kind: undefined };
      return { kind: definition.operation, error: undefined };
    } catch (error) { return { error: error instanceof Error ? error.message : "The operation document is invalid.", kind: undefined }; }
  }, [source, operationName]);
  const ready = runtime.data?.status === "ready" && !runtime.error;
  const canRun = ready && !!idToken.trim() && !!parsed.value && !authored.error && pending === "idle" && (authored.kind !== "mutation" || confirmation === "confirmed");
  const run = async () => {
    if (!canRun || !parsed.value) return;
    setPending("running"); setProblem(undefined); setResult(undefined);
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await graphqlWorkspaceApi.execute({ document: source, variables: parsed.value, ...(operationName.trim() ? { operationName: operationName.trim() } : {}), idToken: idToken.trim(), ...(confirmation === "confirmed" ? { confirmMutation: true as const } : {}) }, abort.signal);
      if (!abort.signal.aborted) setResult(response);
    } catch (error) { if (!abort.signal.aborted) setProblem(error instanceof Error ? error.message : "The local GraphQL request failed."); }
    finally { if (!abort.signal.aborted) { setPending("idle"); setConfirmation("unconfirmed"); } }
  };
  const connection = runtimeStatus(runtime.isPending, runtime.error?.message, runtime.data);
  const reset = () => { setOperation(""); setOperationName(""); setSource(""); setVariables("{}"); setResult(undefined); setProblem(undefined); setConfirmation("unconfirmed"); };
  const notes = [
    !idToken ? { id: "graphql-explorer-token-required", text: "An ID token is required to run an operation.", caution: false } : undefined,
    authored.kind === "mutation" && confirmation !== "confirmed" ? { id: "graphql-explorer-confirm-required", text: "Confirm the mutation before running it.", caution: true } : undefined,
  ].filter(note => note !== undefined);
  return <section aria-labelledby="graphql-explorer-title" className={workbenchPageClasses}>
    <WorkbenchPageHeader icon={Compass} titleId="graphql-explorer-title" title="Explorer" description="Send an operation to this checkout’s local API. Requests run only when you press Run." />
    <section aria-label="Local API connection" className={workbenchCardClasses}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <WorkbenchStatusHeading subject="Local GraphQL API" tone={connection.status.tone === "accept" ? "accept" : connection.status.tone === "caution" ? "caution" : "neutral"} status={<><ChainStatusIcon shape={connection.status.shape} tone={connection.status.tone} size={16} />{connection.status.label}</>} />
        <Button type="button" variant="quiet" disabled={runtime.isFetching} aria-busy={runtime.isFetching} onClick={() => void runtime.refetch()}><RefreshCw size={14} aria-hidden />{runtime.isFetching ? "Checking runtime…" : "Check runtime"}</Button>
      </div>
      <div className="grid gap-1">
        <p className={documentProseClasses}>{connection.message}</p>
        {runtime.data?.endpoint ? <p className="m-0 font-mono text-caption text-graphite wrap-anywhere">{runtime.data.endpoint}</p> : null}
      </div>
      <div className="grid gap-1 border-t border-rule pt-3">
        <div className="flex flex-wrap items-end gap-2"><label className="grid min-w-0 flex-[1_1_320px] gap-1 text-label" htmlFor="graphql-explorer-token">Cognito ID token<TextInput id="graphql-explorer-token" type="password" value={idToken} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={20000} disabled={pending === "running"} onChange={event => { setIdToken(event.target.value); setConfirmation("unconfirmed"); }} aria-describedby="graphql-explorer-token-help" /></label><Button type="button" disabled={!idToken || pending === "running"} onClick={() => { setIdToken(""); setConfirmation("unconfirmed"); }}>Clear token</Button></div>
        <p id="graphql-explorer-token-help" className={documentSupportClasses}>Kept in browser memory for this open workspace. Paste an ID token from your application’s Cognito sign-in.</p>
      </div>
    </section>
    <div className="grid min-w-0 grid-cols-2 items-start gap-4 vp-850:grid-cols-1">
      <section aria-labelledby="graphql-explorer-request" className={workbenchCardClasses}>
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="graphql-explorer-request" className={documentCardTitleClasses}>Request</h3>
            <Button type="button" variant="primary" className="forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText]" disabled={!canRun} aria-busy={pending === "running"} aria-describedby={notes.length ? notes.map(note => note.id).join(" ") : undefined} onClick={() => { void run(); }}><Play size={14} aria-hidden />{pending === "running" ? "Running…" : "Run"}</Button>
          </div>
          {notes.map(note => <p key={note.id} id={note.id} className={note.caution ? "m-0 text-caption leading-[1.5] text-caution" : documentSupportClasses}>{note.text}</p>)}
        </div>
        <label className={fieldClasses} htmlFor="graphql-explorer-operation">Operation<Select id="graphql-explorer-operation" value={operation} disabled={pending === "running"} onChange={event => { const document = operations.find(item => item.id === event.target.value); if (document) load(document); else reset(); }}><option value="">New scratch operation</option>{operations.map(document => <option key={document.id} value={document.id}>{document.name} · {document.kind}</option>)}</Select></label>
        <label htmlFor="graphql-explorer-operation-name" className={fieldClasses}>Operation name (optional)<TextInput id="graphql-explorer-operation-name" value={operationName} disabled={pending === "running"} onChange={event => { setOperationName(event.target.value); setConfirmation("unconfirmed"); }} /></label>
        <div className="grid gap-1">
          <label htmlFor="graphql-explorer-document" className={fieldClasses}>Operation document<Textarea id="graphql-explorer-document" value={source} rows={16} maxLength={65536} spellCheck={false} className="font-mono text-caption" disabled={pending === "running"} onChange={event => { setSource(event.target.value); setOperation(""); setConfirmation("unconfirmed"); }} /></label>
          {source.trim() && authored.error ? <p role="alert" className="m-0 text-caption text-refuse">{authored.error}</p> : null}
        </div>
        <div className="grid gap-1">
          <label htmlFor="graphql-explorer-variables" className={fieldClasses}>Variables<Textarea id="graphql-explorer-variables" value={variables} rows={5} maxLength={100000} spellCheck={false} className="font-mono text-caption" disabled={pending === "running"} onChange={event => { setVariables(event.target.value); setConfirmation("unconfirmed"); }} aria-invalid={!!parsed.error} aria-describedby={parsed.error ? "graphql-variables-error" : undefined} /></label>
          {parsed.error ? <p id="graphql-variables-error" className="m-0 text-caption text-refuse">{parsed.error}</p> : null}
        </div>
        <label className="flex items-center gap-2 text-label"><TextInput type="checkbox" checked={confirmation === "confirmed"} disabled={pending === "running"} onChange={event => setConfirmation(event.target.checked ? "confirmed" : "unconfirmed")} />Allow this run to change local data</label>
      </section>
      <section aria-label="GraphQL result" className={workbenchCardClasses}>
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h3 className={documentCardTitleClasses}>Response</h3>
          {result ? <p role="status" className={documentSupportClasses}>HTTP {result.status} · {result.durationMs} ms</p> : null}
        </div>
        {problem ? <Notice role="alert">{problem}</Notice> : null}
        {result ? <pre tabIndex={0} aria-label="GraphQL response" className={graphqlPreClasses}>{JSON.stringify(result.body, null, 2)}</pre> : pending === "running" ? <p role="status" className={documentSupportClasses}>Waiting for the local API…</p> : <p className={documentSupportClasses}>Run an operation to see its response.</p>}
      </section>
    </div>
  </section>;
}
