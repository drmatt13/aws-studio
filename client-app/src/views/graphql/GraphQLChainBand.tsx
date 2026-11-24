import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronDown, Link as ChainIcon } from "lucide-react";
import type { ChainNode, ChainNodeId, GraphQLChain, LinkId } from "aws-studio/contract-chain/graphql-chain";
import { chainLinkNames, shortFingerprint, stageStatus, standingExplanation, type ChainAvailability, type ChainStatus, type ChainStatusTone } from "../../graphql-chain";
import { cx } from "../../ui/classes";
import { documentTitleClasses, pageWidthClasses } from "../DocumentUI";
import { WorkbenchPageHeader } from "../WorkbenchUI";
import { ChainStatusLabel } from "./ChainStatusIcon";

const nodeFallbacks: ReadonlyArray<Pick<ChainNode, "id" | "caption" | "name" | "source">> = [
  { id: "prisma", caption: "Database contract", name: "contract.prisma", source: "packages/database/prisma/contract.prisma" },
  { id: "pothos", caption: "Pothos schema", name: "graphql-api", source: "compute/http/graphql-api/" },
  { id: "generated", caption: "Generated GraphQL", name: "client-app/src/api/generated", source: "client-app/src/api/generated/" },
  { id: "client", caption: "Client operations", name: "client-app/src/api", source: "client-app/src/api/" },
];
const linkIds: readonly LinkId[] = ["prisma-pothos", "pothos-generated", "generated-client"];

/*
 * The chain is one faceplate, not four cards. Its upper tier has a channel per stage; its lower tier is
 * a recessed track carrying the lineage rail. A review or generator is the interface between two stages,
 * so its gate sits on their shared divider: a grid item spanning both columns and centred on the boundary.
 */
const plateClasses = "max-w-full overflow-x-auto rounded-md border border-rule bg-sheet scrollbar-thin @min-[738px]:overflow-visible forced-colors:border-[CanvasText]";
const stageColumns = ["col-start-1", "col-start-2", "col-start-3", "col-start-4"] as const;
const gateColumns = ["col-span-2 col-start-1", "col-span-2 col-start-2", "col-span-2 col-start-3"] as const;
/*
 * A stage takes the selection wash only while it borders the open section's gate. Pointing at or focusing
 * another gate does not preview its pair: that would tint a third or fourth stage beside the open pair.
 * A stage's secondary text uses `quiet` across both resting and selected surfaces.
 */
/** The track's two rows, shared by each stage's rail segment and each gate so the rail runs through the gates' centres. */
const trackRowsClasses = "grid grid-rows-[16px_28px] gap-y-1 pt-2 pb-3";
/** Gates rise from the recessed track and share the selected surface with their open stage pair. */
const gateClasses = "group/link inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-rule-strong bg-sheet px-2 font-sans text-caption leading-[1.5] font-medium whitespace-nowrap shadow-[0_1px_1px_light-dark(#17233216,#0000001f)] transition-[background-color,border-color] duration-120 not-disabled:hover:border-graphite not-disabled:hover:bg-wash aria-expanded:border-[light-dark(var(--selected-rule),var(--graphite))] aria-expanded:bg-selected disabled:cursor-default disabled:border-rule disabled:shadow-none forced-colors:border-[ButtonText]";

/**
 * A stage's standing against the stage before it, drawn as the rail beneath it: solid once verified,
 * dashed in the status colour while it needs a look or is invalid, dotted and faint while unknown. The
 * first stage is the origin and is not verified against anything, so it and a verified stage share the
 * neutral line: colour marks only what needs attention, and an unknown stage never looks verified or failed.
 */
type Standing = "origin" | ChainStatusTone;
const railClasses: Readonly<Record<Standing, string>> = { origin: "text-graphite", accept: "text-graphite", caution: "text-caution", refuse: "text-refuse", quiet: "text-faint" };
const railDashes: Readonly<Record<Standing, string | undefined>> = { origin: undefined, accept: undefined, caution: "6 4", refuse: "6 4", quiet: "1 5" };

/** Paths wrap after a slash, never inside a segment. */
function breakablePath(path: string): ReactNode {
  return path.split("/").map((segment, index, all) => <Fragment key={index}>{segment}{index < all.length - 1 ? <>/<wbr /></> : null}</Fragment>);
}

interface Reading { readonly label: string; readonly value: string; readonly full?: string; readonly legacy?: string; readonly reading?: boolean }
/**
 * A stage's fingerprints, placed where they are compared: what it was built or reviewed against faces the
 * stage before it (inbound), and what it offers faces the stage after it (outbound). Across each divider
 * the two readings sit side by side above the gate that judges them. A message standing in for a reading,
 * such as "Fingerprint unavailable", keeps that reading's edge and a fingerprint's footprint.
 */
function readings(id: ChainNodeId, node: ChainNode | undefined, availability: "loading" | "available" | "failed"): { readonly inbound?: Reading; readonly outbound: Reading } {
  const reading = (value: ChainNode | undefined, label: string): Reading => {
    const prefix = availability === "failed" ? "Last checked: " : "";
    if (value?.fingerprint.status === "available") return { label: `${prefix}${label}`, value: shortFingerprint(value.fingerprint.value), full: value.fingerprint.value };
    const loading = availability === "loading";
    return { label, value: loading ? "Reading fingerprint…" : "Fingerprint unavailable", reading: loading };
  };
  // Only the recorded ledger can say which upstream content this stage consumed.
  // Copying the preceding block's live output would conceal stale connections.
  const recorded = node?.reviewedAgainst;
  const source = node?.normalizedReviewedAgainst ?? recorded;
  const inbound: Reading = source && /^[a-f0-9]{64}$/.test(source)
    ? { label: "Source SHA-256", value: shortFingerprint(source), full: source, ...(source !== recorded && recorded ? { legacy: recorded } : {}) }
    : { label: "Source SHA-256", value: availability === "loading" ? "Reading fingerprint…" : "Not recorded", reading: availability === "loading" };
  return { ...(id !== "prisma" ? { inbound } : {}), outbound: reading(node, "Generated SHA-256") };
}

/**
 * A labelled fingerprint. Without one, the value slot keeps a short fingerprint's width (nine monospace
 * characters) and shows a mark while the message is read out, so a stage's height and the readings'
 * wrap never change when fingerprints arrive. `trailing` sets it against the next stage.
 */
function Readout({ reading, trailing }: { readonly reading: Reading; readonly trailing: boolean }) {
  return <span title={reading.legacy ? `${reading.full}\nOriginal recorded hash: ${reading.legacy}` : reading.full} className={cx("flex min-w-0 flex-col", trailing && "ml-auto items-end text-right")}>
    <span className="text-meta leading-[1.4] text-quiet">{reading.label}</span>{" "}
    {reading.full
      ? <span className="font-mono text-caption leading-[1.4] wrap-normal">{reading.value}</span>
      : <span title={reading.value} className="min-w-[9ch] font-mono text-caption leading-[1.4] text-quiet">
        {reading.reading
          ? <span aria-hidden="true" className="inline-block h-[0.75em] w-[9ch] rounded-sm bg-rule align-middle motion-safe:animate-pulse" />
          : reading.value === "Not recorded" ? reading.value : <span aria-hidden="true">—</span>}
        {reading.value !== "Not recorded" || reading.reading ? <span className="sr-only">{reading.value}</span> : null}
      </span>}
  </span>;
}

/** One stage's length of the lineage rail. The rail starts at an origin mark and ends in the direction of dependency. */
function RailSegment({ standing, position, scanning, order }: { readonly standing: Standing; readonly position: "first" | "middle" | "last"; readonly scanning: boolean; readonly order: number }) {
  return <span data-chain-rail={standing} className={cx("row-start-2 flex min-w-0 items-center self-center", railClasses[standing], position === "first" && "pl-4", position === "last" && "pr-4")}>
    {position === "first" ? <span className="size-[7px] flex-none rounded-full bg-current" /> : null}
    <span className="relative h-3 min-w-0 flex-1 overflow-hidden">
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 12" preserveAspectRatio="none" focusable="false">
        <path d="M0 6H100" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={railDashes[standing]} strokeLinecap={standing === "quiet" ? "round" : undefined} vectorEffect="non-scaling-stroke" />
      </svg>
      {scanning ? <span className="absolute inset-x-0 top-[5px] h-0.5 animate-chain-scan bg-[linear-gradient(90deg,transparent_calc(100%-48px),var(--ink)_calc(100%-6px),transparent)] opacity-0 motion-reduce:hidden" style={{ animationDelay: `${order * 0.6}s` }} /> : null}
    </span>
    {position === "last" ? <svg className="flex-none" width="8" height="12" viewBox="0 0 8 12" focusable="false"><path d="M0 6H7M3 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
  </span>;
}

/**
 * The contract chain is page content, not chrome: it sits on the page surface in the document column
 * and stays above the independently scrolling detail region. An open gate drops a stem to that region,
 * where its detail card begins. Nothing is inserted between the header and the plate, so conditions
 * arriving later never shift the chain; a remedy belongs in `actions`.
 */
export function GraphQLChainBand({ chain, selected, focused, availability, checking = false, retained = false, actions, onSelect }: {
  readonly chain?: GraphQLChain;
  readonly selected: LinkId | null;
  readonly focused?: LinkId;
  readonly availability: ChainAvailability;
  /** A check is in progress: the rail shows a scan while the last result stays readable. */
  readonly checking?: boolean;
  /** The latest read has not been superseded by a known source change. */
  readonly retained?: boolean;
  readonly actions?: ReactNode;
  readonly onSelect: (link: LinkId) => void;
}) {
  const layers = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = layers.current, link = focused ? container?.querySelector<HTMLElement>(`[data-chain-link="${focused}"]`) : null;
    if (container && link) { const bounds = container.getBoundingClientRect(), item = link.getBoundingClientRect(); container.scrollLeft += item.left - bounds.left - (bounds.width - item.width) / 2; }
  }, [focused]);
  const statusOf = (linkId: LinkId): ChainStatus => stageStatus(chain, linkId, { availability, checking, retained });
  const scanning = checking || availability === "loading";
  return <section data-ui="graphql-chain" aria-labelledby="graphql-chain-heading" className={cx(pageWidthClasses, "@container grid flex-none gap-4 pt-4 pb-4")}>
    <WorkbenchPageHeader icon={ChainIcon} titleId="graphql-chain-heading" title="Contract chain" description="Saved approvals follow matching source across checkouts. Check again runs independent validation on this installation." actions={actions} />
    <div ref={layers} role="region" aria-label="Contract chain layers" tabIndex={0} className={plateClasses}>
      <ol className="m-0 grid min-w-[736px] list-none grid-cols-4 p-0">
        {nodeFallbacks.map((fallback, index) => {
          const node = chain?.nodes.find(item => item.id === fallback.id);
          const linkId = linkIds[index], link = chain?.links.find(item => item.id === linkId);
          const status = linkId ? statusOf(linkId) : undefined;
          const inboundId = index ? linkIds[index - 1] : undefined;
          const standing: Standing = inboundId ? statusOf(inboundId).tone : "origin";
          const nodeFocused = focused === linkIds[index] || (index > 0 && focused === linkIds[index - 1]);
          const { inbound, outbound } = readings(fallback.id, node, availability);
          const position = index === 0 ? "first" : index === nodeFallbacks.length - 1 ? "last" : "middle";
          const open = selected === linkId && availability === "available" && Boolean(link);
          return <Fragment key={fallback.id}>
            <li data-chain-node={fallback.id} data-focus={nodeFocused ? "focused" : "idle"} data-standing={standing} className={cx(stageColumns[index], "row-start-1 grid min-w-0 grid-rows-[1fr_auto]")}>
              <div className={cx("flex min-w-0 flex-col px-4 py-3 transition-[background-color] duration-120 @max-[737px]:px-3", index > 0 && "border-l border-rule", nodeFocused && "bg-selected", position === "first" && "rounded-tl-[5px]", position === "last" && "rounded-tr-[5px]")}>
                <span className="flex items-baseline justify-between gap-3">
                  <strong className={documentTitleClasses}>{node?.caption ?? fallback.caption}</strong>
                  <span aria-hidden="true" className="font-mono text-meta text-quiet">{index + 1}</span>
                </span>
                <span className="font-mono text-caption leading-[1.5] break-words text-quiet" title={node?.source ?? fallback.source}>{breakablePath(node?.name ?? fallback.name)}</span>
                <span className="mt-auto flex flex-wrap items-end gap-x-2 gap-y-1 pt-3">
                  {inbound ? <Readout reading={inbound} trailing={false} /> : null}
                  {outbound ? <Readout reading={outbound} trailing /> : null}
                </span>
              </div>
              <div aria-hidden="true" className={cx(trackRowsClasses, "border-t border-rule bg-paper", position === "first" && "rounded-bl-[5px]", position === "last" && "rounded-br-[5px]")}>
                <RailSegment standing={standing} position={position} scanning={scanning} order={index} />
              </div>
            </li>
            {linkId && status ? <li data-chain-link={linkId} aria-current={focused === linkId ? "step" : undefined} className={cx(gateColumns[index], trackRowsClasses, "relative z-1 row-start-1 min-w-0 justify-items-center self-end justify-self-center")}>
              <span className={cx("text-meta leading-4 whitespace-nowrap", focused === linkId ? "font-medium text-ink" : "text-graphite")}>{chainLinkNames[linkId]}</span>
              <button type="button" className={gateClasses} title={standingExplanation(status) ?? (link?.confidence.diagnostics.map(item => item.message).join("\n") || undefined)} disabled={availability !== "available" || !link} aria-label={`${chainLinkNames[linkId]}: ${status.label}`} aria-expanded={selected === linkId} aria-controls="graphql-chain-detail" onFocus={event => event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" })} onClick={() => onSelect(linkId)}>
                <ChainStatusLabel status={status} />
                {availability === "available" && link ? <ChevronDown size={14} aria-hidden className="flex-none text-graphite group-aria-expanded/link:rotate-180" /> : null}
              </button>
              {/* From the gate through the plate's edge and the section's 16px foot, to where the detail card begins. */}
              {open ? <span aria-hidden="true" data-chain-stem="" className="pointer-events-none absolute -bottom-[17px] left-1/2 h-[29px] w-px -translate-x-1/2 bg-faint forced-colors:bg-[CanvasText]" /> : null}
            </li> : null}
          </Fragment>;
        })}
      </ol>
    </div>
  </section>;
}
