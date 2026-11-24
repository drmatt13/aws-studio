import { Check, ClipboardCheck, ExternalLink, History, Pause, Sparkles, TriangleAlert, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { editorLink } from "../lookup";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import type { HealthCapability, HealthCapabilityState, HealthCondition, HealthFinding } from "./conditions";
import { SEVERITY_ICON } from "./severity";

const SEVERITY_TEXT: Readonly<Record<HealthCondition["severity"], string>> = { error: "text-refuse", warning: "text-caution", notice: "text-graphite" };
const CAPABILITY_ROWS: readonly { readonly state: HealthCapabilityState; readonly label: string; readonly Icon: LucideIcon }[] = [
  { state: "paused", label: "Paused", Icon: Pause },
  { state: "last-loaded", label: "Last loaded", Icon: History },
  { state: "caution", label: "Limited", Icon: TriangleAlert },
  { state: "working", label: "Still working", Icon: Check },
];
const STAGE: Readonly<Record<NonNullable<HealthFinding["stage"]>, string>> = {
  validate: "Validation", "cloud-edges": "Cloud edges", "source-index": "Source index",
};

export interface HealthRecovery {
  readonly reloading: boolean;
  readonly reloadDisabled: boolean;
  readonly onReload: () => void;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onAskAgent: (condition: HealthCondition) => void;
  readonly onShowEntity: (entity: string) => void;
}

/** Scope is stated only when it narrows the problem: a failure in both modes needs no label. */
function scopeOf(finding: HealthFinding): string | undefined {
  const parts = [
    ...(finding.modes.length === 1 ? [finding.modes[0] === "dev" ? "Development only" : "Production only"] : []),
    ...(finding.stage ? [STAGE[finding.stage]] : []),
  ];
  return parts.join(", ") || undefined;
}

function Finding({ finding, repositoryRoot, onShowEntity }: { readonly finding: HealthFinding; readonly repositoryRoot: string; readonly onShowEntity: (entity: string) => void }) {
  const { location, entity } = finding;
  const scope = scopeOf(finding);
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-rule bg-paper">
      {location ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-rule py-1 pr-1 pl-3">
          <span className="min-w-0 font-mono text-meta wrap-anywhere">{location.file}:{location.line}:{location.column}</span>
          <a className={buttonClasses({ variant: "quiet", size: "compact", className: "flex-none coarse:min-h-11" })} href={editorLink(repositoryRoot, location)}>
            <ExternalLink size={13} aria-hidden /> Open in VS Code
          </a>
        </div>
      ) : null}
      <div className="grid gap-1 px-3 py-2">
        <p className="m-0 font-mono text-meta leading-normal whitespace-pre-wrap wrap-anywhere">{finding.summary}</p>
        {finding.detail ? (
          <details className="text-caption text-graphite">
            <summary className="min-h-6 cursor-pointer coarse:min-h-11">Details</summary>
            <pre className="m-0 max-h-48 overflow-auto font-mono text-meta whitespace-pre-wrap wrap-anywhere">{finding.detail}</pre>
          </details>
        ) : null}
        {scope || entity ? (
          <p className="m-0 flex flex-wrap items-center gap-x-3 text-caption text-graphite">
            {scope ? <span>{scope}</span> : null}
            {entity ? (
              <button type="button" className={buttonClasses({ variant: "link", className: "text-caption coarse:min-h-11" })} onClick={() => onShowEntity(entity)}>
                Show {entity}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function capabilityText({ name, note }: HealthCapability): string {
  return note ? `${name} ${note}` : name;
}

/** Each row reports what the code enforces, so the list can be trusted over guesswork. */
function Capabilities({ capabilities }: { readonly capabilities: readonly HealthCapability[] }) {
  const rows = CAPABILITY_ROWS.flatMap((row) => {
    const names = capabilities.filter((item) => item.state === row.state);
    return names.length ? [{ ...row, names }] : [];
  });
  if (!rows.length) return null;
  return (
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-caption vp-480:grid-cols-1 vp-480:gap-y-0.5">
      {rows.map(({ state, label, Icon, names }) => (
        <div key={state} className="contents">
          <dt className="inline-flex items-center gap-1.5 text-graphite vp-480:mt-1.5"><Icon size={12} aria-hidden />{label}</dt>
          <dd className="m-0">{names.map(capabilityText).join(". ")}</dd>
        </div>
      ))}
    </dl>
  );
}

function ConditionSection({ condition, repositoryRoot, recovery }: { readonly condition: HealthCondition; readonly repositoryRoot: string; readonly recovery: HealthRecovery }) {
  const heading = useId();
  const Mark = SEVERITY_ICON[condition.severity];
  return (
    <section aria-labelledby={heading} data-condition={condition.id} className="grid min-w-0 gap-3 not-first:border-t not-first:border-rule not-first:pt-4">
      <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2">
        <Mark size={16} className={cx("mt-0.75", SEVERITY_TEXT[condition.severity])} aria-hidden />
        <h3 id={heading} className="m-0 font-sans text-body font-semibold text-balance">{condition.title}</h3>
        <p className="col-start-2 m-0 text-caption text-graphite">{condition.explanation}</p>
      </div>
      {condition.findings.length ? (
        <div className="grid min-w-0 gap-2">
          {condition.findings.map((finding) => <Finding key={finding.key} finding={finding} repositoryRoot={repositoryRoot} onShowEntity={recovery.onShowEntity} />)}
        </div>
      ) : null}
      {condition.askAgent || condition.action ? (
        <div className="flex flex-wrap gap-2">
          {condition.askAgent ? (
            <button type="button" className={buttonClasses({ variant: "neutral", size: "compact", className: "coarse:min-h-11" })} onClick={() => recovery.onAskAgent(condition)}>
              <Sparkles size={13} aria-hidden /> Ask in Conversation
            </button>
          ) : null}
          {condition.action === "reload-source" ? (
            <button type="button" className={buttonClasses({ variant: "quiet", size: "compact", className: "coarse:min-h-11" })} disabled={recovery.reloadDisabled} onClick={recovery.onReload}>
              {recovery.reloading ? "Reloading source…" : "Reload source"}
            </button>
          ) : null}
          {condition.action === "retry-refresh" ? (
            <button type="button" className={buttonClasses({ variant: "quiet", size: "compact", className: "coarse:min-h-11" })} disabled={recovery.retrying} onClick={recovery.onRetry}>
              {recovery.retrying ? "Connecting…" : "Try again"}
            </button>
          ) : null}
        </div>
      ) : null}
      <Capabilities capabilities={condition.capabilities} />
    </section>
  );
}

export function HealthPanel({ conditions, repositoryRoot, recovery, checkDisabled, onCheck }: {
  readonly conditions: readonly HealthCondition[];
  readonly repositoryRoot: string;
  readonly recovery: HealthRecovery;
  readonly checkDisabled: boolean;
  readonly onCheck: () => void;
}) {
  const Healthy = SEVERITY_ICON.healthy;
  return (
    <>
      {conditions.length ? (
        conditions.map((condition) => <ConditionSection key={condition.id} condition={condition} repositoryRoot={repositoryRoot} recovery={recovery} />)
      ) : (
        <p className="m-0 flex items-start gap-2"><Healthy size={16} className="mt-0.75 flex-none text-accept" aria-hidden />All source graphs load and pass configuration validation.</p>
      )}
      <div className="grid gap-2 border-t border-rule pt-4">
        <p className="m-0 text-caption text-graphite">
          Source validation checks the saved declarations in each framework mode. It does not
          establish AWS credentials, deployment status or application health. Inspector changes are
          validated before applying.
        </p>
        <details>
          <summary className="min-h-6 cursor-pointer coarse:min-h-11">Additional checks</summary>
          <p className="text-caption text-graphite">
            Audit generated files and local wiring with framework:check. This separate check runs on
            saved source and writes nothing.
          </p>
          <button type="button" className={buttonClasses({ variant: "quiet", className: "coarse:min-h-11" })} disabled={checkDisabled} onClick={onCheck}>
            <ClipboardCheck size={16} aria-hidden /> Check generated files and wiring
          </button>
        </details>
      </div>
    </>
  );
}
