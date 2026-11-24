import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import type { LinkId, ReviewPlan, ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import type { GraphQLDocument } from "../../shared/graphql-workspace";
import { codingTaskActive } from "../../shared/agent-runtime";
import { graphqlChainApi } from "../graphql-chain-api";
import { graphqlWorkspaceApi } from "../graphql-workspace-api";
import { graphQLCodingDrafts } from "../graphql-chain-agent-request";
import { CONTRACT_STAGES, contractLinkForStage, contractStageForLink, nextContractStage, type ContractStage } from "../../shared/contract-propagation";
import { openCodingTask, prepareCodingTask } from "../coding-task-navigation";
import { useCodingTasks } from "../agent-tasks";
import { api } from "../api";
import { ledgerStatus, stageStatus, type ChainAvailability } from "../graphql-chain";
import { ApiError } from "../http";
import { AppWindow, CircleHelp, Compass, FileCode2, History, PenLine, RefreshCw } from "lucide-react";
import { useStudio } from "../studio";
import { Button } from "../ui/Button";
import { cx } from "../ui/classes";
import { iconButtonClasses } from "../ui/IconButton";
import { Notice, workspaceToolbarClasses } from "../ui/Surface";
import { documentSupportClasses, pageWidthClasses } from "./DocumentUI";
import { RetryNotice } from "./RetryNotice";
import { workbenchEmptyClasses, workbenchPageClasses } from "./WorkbenchUI";
import { GraphQLChainBand } from "./graphql/GraphQLChainBand";
import { GraphQLChainDetails, GraphQLChainHistory } from "./graphql/GraphQLChainDetails";
import { GraphQLChainDecisionReview, GraphQLChainReview, type ContractReviewDecisions } from "./graphql/GraphQLChainReview";
import { contractPrimaryClasses, GraphQLContractWorkflow } from "./graphql/GraphQLContractWorkflow";
import { GraphQLHelp } from "./graphql/GraphQLHelp";
import { GraphQLSchema } from "./graphql/GraphQLSchema";
import { GraphQLClient } from "./graphql/GraphQLClient";
import { GraphQLExplorer, type PreparedGraphQLDocument } from "./graphql/GraphQLExplorer";
import { NavigationStrip, navigationItemClasses } from "./NavigationStrip";

export type GraphQLSection = "schema" | "explorer" | "client";
const sectionLinks: Readonly<Record<GraphQLSection, LinkId>> = { schema: "prisma-pothos", explorer: "pothos-generated", client: "generated-client" };
const linkSections: Readonly<Record<LinkId, GraphQLSection>> = { "prisma-pothos": "schema", "pothos-generated": "explorer", "generated-client": "client" };
/** Schema shares Database's Schema icon; Run in Explorer reuses the Explorer compass. */
const sections = [
  { id: "schema", label: "Schema", icon: FileCode2 },
  { id: "explorer", label: "Explorer", icon: Compass },
  { id: "client", label: "Client", icon: AppWindow },
] as const;

export function GraphQL() {
  // The chain follows saved source even while an Inspector draft keeps an older baseline.
  const { response: { snapshot } } = useStudio();
  const pathname = useLocation({ select: location => location.pathname });
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { readonly document?: string };
  const section: GraphQLSection = pathname.endsWith("/explorer") ? "explorer" : pathname.endsWith("/client") ? "client" : "schema";
  return <GraphQLWorkspace repositoryRoot={snapshot.repositoryRoot} snapshotRevision={snapshot.revision} section={section} initialDocumentId={search.document} onSectionChange={(next, document) => { void navigate({ to: `/graphql/${next}`, search: previous => ({ ...previous, document }) }); }} />;
}

export function GraphQLWorkspace({ repositoryRoot, snapshotRevision, section, initialDocumentId, onSectionChange }: { readonly repositoryRoot: string; readonly snapshotRevision: string; readonly section?: GraphQLSection; readonly initialDocumentId?: string; readonly onSectionChange?: (section: GraphQLSection, documentId?: string) => void }) {
  const coding = useCodingTasks(true, repositoryRoot, { details: false });
  const [localSection, setLocalSection] = useState<GraphQLSection>("schema");
  const activeSection = section ?? localSection;
  const previousSection = useRef(activeSection);
  const [prepared, setPrepared] = useState<PreparedGraphQLDocument>();
  const scrollRegion = useRef<HTMLDivElement>(null);
  const loadedDocument = useRef<string | undefined>(undefined);
  const workspace = useQuery({ queryKey: ["graphql-workspace", repositoryRoot], queryFn: ({ signal }) => graphqlWorkspaceApi.load(signal), retry: false, staleTime: 0, refetchOnWindowFocus: "always" });
  useEffect(() => {
    if (initialDocumentId && loadedDocument.current !== initialDocumentId) {
      const document = workspace.data?.client.documents.find(item => item.id === initialDocumentId && item.executableSource && ["query", "mutation"].includes(item.kind));
      if (document) { loadedDocument.current = initialDocumentId; setPrepared({ id: crypto.randomUUID(), document }); }
    }
  }, [initialDocumentId, workspace.data]);
  const readMode = useRef<"cached" | "fresh" | "refresh">("cached");
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const reviewOrigin = useRef<HTMLElement | null>(null);
  const restoreReviewOrigin = useRef(false);
  const chain = useQuery({
    queryKey: ["graphql-chain", repositoryRoot],
    queryFn: ({ signal }) => { const mode = readMode.current; readMode.current = "cached"; return graphqlChainApi.load(signal, mode); },
    retry: false, staleTime: 0, refetchOnWindowFocus: "always",
    refetchInterval: query => query.state.data?.fingerprints === "checking" || query.state.data?.inspection?.status === "checking" ? 500 : 2000,
  });
  const checking = chain.isFetching || chain.data?.inspection?.status === "checking";
  const reviewEvidenceCurrent = !chain.data?.inspection || chain.data.inspection.status === "ready";
  const { refetch } = chain;
  const approvalChecks = useRef({ repository: repositoryRoot, covered: new Set<string>() });
  useEffect(() => {
    if (approvalChecks.current.repository !== repositoryRoot) approvalChecks.current = { repository: repositoryRoot, covered: new Set() };
    if (!coding.list.data || coding.listError || chain.isFetching || chain.status === "pending" || chain.data?.inspection?.status === "checking" || chain.data?.fingerprints === "checking") return;
    const pending = coding.list.data.tasks.filter(task => task.contract?.approval?.status === "approved" && !approvalChecks.current.covered.has(task.id));
    if (!pending.length) return;
    const checkedAt = Date.parse(chain.data?.inspection?.checkedAt ?? "");
    // Cover the whole observed batch before requesting a check. Polling a failed
    // check cannot repeatedly restart it, including after a completed-task reload.
    for (const task of pending) approvalChecks.current.covered.add(task.id);
    if (chain.data?.inspection?.status === "ready" && pending.every(task => Date.parse(task.updatedAt) <= checkedAt)) return;
    if (pending.every(task => task.contract && ledgerStatus(contractLinkForStage(task.contract.stage), chain.data?.nodes)?.shape === "passed")) return;
    readMode.current = "refresh"; void refetch(); void workspace.refetch();
  }, [repositoryRoot, coding.list.data, coding.listError, chain.data, chain.isFetching, chain.status, refetch, workspace.refetch]);
  const previousRevision = useRef(snapshotRevision);
  // Until the server says otherwise, the last read describes saved source. A source change or an explicit
  // check outdates it until the read they start completes; a background read alone (a focus refetch takes
  // seconds) leaves it standing, so the contract card stays put while its actions pause. Read completion,
  // not update time, ends the wait: identical responses keep their data and the clock may not advance.
  const [readOutdated, setReadOutdated] = useState(false);
  const wasFetching = useRef(chain.isFetching);
  useEffect(() => {
    if (wasFetching.current && !chain.isFetching) setReadOutdated(false);
    wasFetching.current = chain.isFetching;
  }, [chain.isFetching]);
  const savedSourceCurrent = reviewEvidenceCurrent && !readOutdated;
  // A network read pauses actions without erasing current evidence. Known source
  // changes and explicit checks hide superseded observations until that read ends.
  const checkingEvidence = readOutdated || chain.data?.inspection?.status === "checking";
  const readingHashes = !chain.error && (chain.isPending || chain.data?.fingerprints === "checking");
  const checkingChain = readingHashes || checkingEvidence;
  useEffect(() => {
    if (previousRevision.current !== snapshotRevision) { previousRevision.current = snapshotRevision; setReadOutdated(true); void refetch(); void workspace.refetch(); }
  }, [snapshotRevision, refetch, workspace.refetch]);
  const [selected, setSelected] = useState<LinkId | null | undefined>(undefined);
  useLayoutEffect(() => { if (scrollRegion.current) scrollRegion.current.scrollTop = 0; }, [activeSection]);
  useEffect(() => {
    if (previousSection.current !== activeSection) { previousSection.current = activeSection; setSelected(sectionLinks[activeSection]); }
  }, [activeSection]);
  const [review, setReview] = useState<ReviewPlan>();
  const [decisionReview, setDecisionReview] = useState<{ readonly scope: Exclude<ReviewScope, { readonly kind: "model" }>; readonly expectedRevision: string }>();
  const [pending, setPending] = useState<"idle" | "reviewing" | "recording">("idle");
  const [regenerating, setRegenerating] = useState(false);
  const regenerationRunning = useRef(false);
  const [problem, setProblem] = useState<string>();
  const [recorded, setRecorded] = useState<string>();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    if (restoreFocus.current && pending === "idle" && !checking) { restoreFocus.current = false; refreshButton.current?.focus(); }
  }, [pending, checking]);
  useEffect(() => {
    if (!review && !decisionReview && pending === "idle" && restoreReviewOrigin.current) {
      restoreReviewOrigin.current = false;
      (reviewOrigin.current?.isConnected ? reviewOrigin.current : refreshButton.current)?.focus();
    }
  }, [review, decisionReview, pending]);
  const selectedId = selected === undefined ? sectionLinks[activeSection] : selected;
  const link = chain.data?.links.find(item => item.id === selectedId);
  const restart = chain.error instanceof ApiError && chain.error.status === 404;
  const check = () => { setProblem(undefined); setRecorded(undefined); setReadOutdated(true); readMode.current = "fresh"; void chain.refetch(); void workspace.refetch(); };
  const changeSection = (next: GraphQLSection, documentId?: string) => { if (onSectionChange) onSectionChange(next, documentId); else setLocalSection(next); };
  const explore = (document: GraphQLDocument) => { setPrepared({ id: crypto.randomUUID(), document }); changeSection("explorer", document.id); };
  const prepareReview = async (scope: ReviewScope, expectedRevision: string, decisions?: ContractReviewDecisions) => {
    if (!chain.data || checking || !reviewEvidenceCurrent || pending !== "idle" || chain.data.revision !== expectedRevision) return;
    setProblem(undefined); setRecorded(undefined); setPending("reviewing");
    try { setReview(await graphqlChainApi.review({ expectedRevision, scope, ...(decisions ? { decisions } : {}) })); setDecisionReview(undefined); }
    catch (error) { restoreReviewOrigin.current = true; setProblem(error instanceof Error ? error.message : "The review could not be prepared."); }
    finally { setPending("idle"); }
  };
  const acknowledge = async (scope: ReviewScope) => {
    if (!chain.data || checking || !reviewEvidenceCurrent || pending !== "idle") return;
    reviewOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProblem(undefined); setRecorded(undefined);
    if (scope.kind !== "model") { setDecisionReview({ scope, expectedRevision: chain.data.revision }); return; }
    await prepareReview(scope, chain.data.revision);
  };
  const accept = async () => {
    if (!review || checking || !reviewEvidenceCurrent || pending !== "idle" || chain.data?.revision !== review.expectedRevision) return;
    setProblem(undefined); setPending("recording");
    try {
      const result = await graphqlChainApi.accept({ reviewId: review.reviewId, expectedRevision: review.expectedRevision });
      setReview(undefined); setRecorded(result.message); readMode.current = "fresh"; restoreFocus.current = true;
      await chain.refetch();
    } catch (error) { setProblem(error instanceof Error ? error.message : "The review could not be recorded."); }
    finally { setPending("idle"); }
  };
  const availability: ChainAvailability = readingHashes ? "loading" : chain.error || chain.data?.fingerprints === "failed" ? "failed" : "available";
  const statusOptions = { availability, checking: checkingEvidence, retained: !readOutdated };
  const statusForStage = (stage: ContractStage) => stageStatus(chain.data, contractLinkForStage(stage), statusOptions);
  const selectedStage = link ? contractStageForLink(link.id) : undefined;
  const standing = selectedStage ? statusForStage(selectedStage) : undefined;
  const nextStage = chain.data && !chain.error ? nextContractStage(chain.data) : null;
  const actionDisabled = (stage: ContractStage | "full") => {
    if (pending !== "idle") return true;
    if (stage === "full") return CONTRACT_STAGES.every(item => statusForStage(item).shape === "passed");
    const status = statusForStage(stage);
    return status.shape === "passed" || stage === "codegen" && (checkingChain || regenerating || status.label === "Waiting for upstream");
  };
  const draftContractTask = (stage: ContractStage | "full") => {
    if (actionDisabled(stage)) return;
    try { prepareCodingTask(repositoryRoot, { id: crypto.randomUUID(), prompt: graphQLCodingDrafts[stage].prompt }); }
    catch (error) { setProblem(error instanceof Error ? error.message : "The coding draft could not be opened."); }
  };
  const regenerateGraphQL = async () => {
    if (regenerationRunning.current || actionDisabled("codegen")) return;
    regenerationRunning.current = true;
    setRegenerating(true); setProblem(undefined); setRecorded(undefined);
    try {
      const result = await api.command("graphql:regenerate", true);
      if (result.exitCode !== 0) throw new Error(`GraphQL regeneration stopped. ${result.output.trim().slice(-4000)}`);
      setRecorded("GraphQL outputs regenerated.");
      void chain.refetch(); void workspace.refetch();
    } catch (error) {
      setProblem(error instanceof ApiError && error.status === 404 ? "Restart Studio to use GraphQL regeneration." : error instanceof Error ? error.message : "GraphQL regeneration failed.");
    } finally { regenerationRunning.current = false; setRegenerating(false); }
  };
  const contractTasks = coding.list.data?.tasks.filter(task => task.contract && task.status !== "rejected") ?? [];
  const contractTask = contractTasks.find(task => codingTaskActive(task) || task.contract?.approval?.status === "checking") ?? contractTasks[0];
  return (
    <div data-ui="graphql-workbench" className="flex h-full min-h-0 flex-col overflow-hidden">
      <h1 className="sr-only">GraphQL</h1>
      <div data-ui="workspace-toolbar graphql-navigation" className={cx(workspaceToolbarClasses, "flex flex-none items-center justify-between gap-2")}>
        <NavigationStrip className="min-w-0 flex-1" label="GraphQL sections" activeKey={activeSection}>
          {sections.map(item => <a key={item.id} href={`/graphql/${item.id}`} className={navigationItemClasses} aria-current={activeSection === item.id ? "page" : undefined} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); changeSection(item.id); } }}>
            <item.icon size={15} aria-hidden />
            {item.label}
          </a>)}
        </NavigationStrip>
        <button type="button" data-ui="graphql-help-toggle" className={cx(iconButtonClasses(), "shrink-0 border-transparent bg-transparent text-graphite")} title="How this works" aria-label="How this works" aria-haspopup="dialog" aria-expanded={help} aria-controls={help ? "graphql-workbench-help" : undefined} onClick={() => setHelp(true)}>
          <CircleHelp size={16} aria-hidden />
        </button>
      </div>
      {help ? <GraphQLHelp onClose={() => setHelp(false)} /> : null}
      <div ref={scrollRegion} data-ui="graphql-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <GraphQLChainBand chain={chain.data} selected={selectedId} focused={sectionLinks[activeSection]} availability={availability} checking={checkingEvidence} retained={!readOutdated} onSelect={id => { const target = linkSections[id]; if (target !== activeSection) changeSection(target); else setSelected(selectedId === id ? null : id); }}
          actions={<>
            <Button type="button" variant="primary" className={contractPrimaryClasses} disabled={actionDisabled("full")} onClick={() => draftContractTask("full")}><PenLine size={14} aria-hidden />{graphQLCodingDrafts.full.label}</Button>
            {/* Polling retries in the background; staying enabled keeps the toolbar from blinking with each attempt. */}
            {coding.listError ? <Button type="button" variant="quiet" onClick={coding.retry}><History size={14} aria-hidden />Retry task history</Button> : null}
            <Button ref={refreshButton} type="button" variant="quiet" disabled={checkingChain || regenerating || pending !== "idle"} aria-busy={checkingChain} onClick={check}><RefreshCw size={14} aria-hidden className={checkingChain ? "motion-safe:animate-spin" : undefined} />
              {/* Both labels share one cell so the button keeps the wider width: a background check never re-wraps the header. */}
              <span className="grid">
                <span aria-hidden={checkingChain} className={cx("col-start-1 row-start-1", checkingChain && "invisible")}>Check again</span>
                <span aria-hidden={!checkingChain} className={cx("col-start-1 row-start-1", !checkingChain && "invisible")}>Checking…</span>
              </span>
            </Button>
          </>} />
        <div id="graphql-chain-detail" role="region" aria-label="Contract chain detail">
          <div data-ui="graphql-page" className={cx(pageWidthClasses, workbenchPageClasses, "pb-6")}>
            {chain.data?.inspection?.status === "checking" ? <p role="status" className={documentSupportClasses}>{chain.data.inspection.message ?? "Checking the contract chain in the background…"}</p> : null}
            {readingHashes ? <p role="status" className={documentSupportClasses}>{chain.isPending ? "Checking contract chain…" : "Reading saved contract hashes…"}</p> : null}
            {!chain.error && chain.data?.fingerprints === "failed" ? <Notice role="alert">Saved contract hashes are unavailable. Use Check again to retry.</Notice> : null}
            {chain.error ? <RetryNotice message={restart ? "Restart Studio, then reload this page to use the contract chain." : <>Couldn’t read the contract chain. {chain.error.message}</>} retryLabel="Try again" retrying={chain.isFetching} onRetry={check} /> : null}
            {problem && !review && !decisionReview ? <Notice role="alert" className="whitespace-pre-wrap">{problem}</Notice> : null}
            {recorded ? <Notice role="status" tone="success">{recorded}</Notice> : null}
            {/* The open gate's stem lands on the review it opens, so that review is the first card under the chain. */}
            {!chain.error && link && selectedStage ? <GraphQLChainDetails link={link} standing={standing} verification={chain.data?.verification} proof={chain.data?.proof} proofCurrent={savedSourceCurrent} retained={!readOutdated} onAcknowledge={scope => { void acknowledge(scope); }} pending={pending === "idle" && (checking || regenerating) ? "checking" : pending} onDraft={draftContractTask} onRegenerate={() => void regenerateGraphQL()} regenerating={regenerating} actionDisabled={actionDisabled(selectedStage)} /> : null}
            <GraphQLContractWorkflow stage={nextStage} task={contractTask} taskCurrent={!coding.listError} sourceCurrent={!!chain.data && !chain.error && savedSourceCurrent} checking={regenerating || (nextStage !== null && actionDisabled(nextStage))} onStart={draftContractTask} onRegenerate={() => void regenerateGraphQL()} onOpen={task => openCodingTask(repositoryRoot, task)} />
            {chain.data?.history ? <GraphQLChainHistory history={chain.data.history} /> : null}
            {workspace.isPending ? <p role="status" className={workbenchEmptyClasses}>Reading GraphQL source…</p> : workspace.error ? <RetryNotice message={<>Couldn’t read GraphQL source. {workspace.error.message}</>} retryLabel="Retry source read" retrying={workspace.isFetching} onRetry={() => { void workspace.refetch(); }} /> : workspace.data ? <>
              <div hidden={activeSection !== "schema"} inert={activeSection !== "schema"}><GraphQLSchema schema={workspace.data.schema} /></div>
              <div hidden={activeSection !== "explorer"} inert={activeSection !== "explorer"}><GraphQLExplorer client={workspace.data.client} repositoryRoot={repositoryRoot} visible={activeSection === "explorer"} prepared={prepared} /></div>
              <div hidden={activeSection !== "client"} inert={activeSection !== "client"}><GraphQLClient client={workspace.data.client} repositoryRoot={repositoryRoot} onExplore={explore} /></div>
            </> : null}
          </div>
        </div>
      </div>
      {decisionReview ? <GraphQLChainDecisionReview key={`${decisionReview.scope.kind}:${decisionReview.expectedRevision}`} scope={decisionReview.scope} expectedRevision={decisionReview.expectedRevision} currentRevision={chain.error || !reviewEvidenceCurrent ? undefined : chain.data?.revision} pending={pending === "reviewing" ? "reviewing" : checking ? "checking" : "idle"} problem={problem} onBack={() => { if (pending === "idle") { restoreReviewOrigin.current = true; setDecisionReview(undefined); setProblem(undefined); } }} onPrepare={decisions => { void prepareReview(decisionReview.scope, decisionReview.expectedRevision, decisions); }} /> : null}
      {review ? <GraphQLChainReview review={review} pending={pending === "recording" ? "recording" : checking ? "checking" : "idle"} currentRevision={chain.error || !reviewEvidenceCurrent ? undefined : chain.data?.revision} problem={problem} onBack={() => { if (pending === "idle") { restoreReviewOrigin.current = true; setReview(undefined); setProblem(undefined); } }} onAccept={() => { void accept(); }} /> : null}
    </div>
  );
}
