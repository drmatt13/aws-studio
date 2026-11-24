import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { GRAPH_ACTIONS } from "aws-studio/database/access-graph";
import type { AccessModules, readClientAccess, SourceDirective } from "aws-studio/database/client-access";
import { Button } from "../ui/Button";
import { accessDirectiveLine, roleHoldings, toggleRoleHolding } from "./access-authoring";

type ParsedAccess = ReturnType<typeof readClientAccess>;

export function rolePermissionItems(graph: ParsedAccess["graph"]["enums"][string]) {
  const masks = Object.values(graph.masks);
  return [...GRAPH_ACTIONS.filter(action => masks.some(mask => mask.includes(action))), ...Object.keys(graph.permissions)];
}

interface RoleMatrixProps {
  readonly source: string;
  readonly parsed: ParsedAccess;
  readonly directives: readonly SourceDirective[];
  readonly enumeration: string;
  readonly selected?: string;
  readonly modules?: AccessModules;
  readonly onApplySource?: (next: string) => void;
  readonly onNavigate: (line: number) => void;
  readonly inline?: boolean;
}

/** Both presentations stage the same validated, undoable edit to a role's authored rules. */
export function RolePermissionMatrix({ source, parsed, directives, enumeration, selected, modules, onApplySource, onNavigate, inline }: RoleMatrixProps) {
  const [rejection, setRejection] = useState<{ source: string; message: string }>();
  const toggle = onApplySource && ((role: string, item: string) => {
    const proposal = toggleRoleHolding(source, parsed, enumeration, role, item, modules);
    if (proposal.problem) setRejection({ source, message: proposal.problem });
    else {
      setRejection(undefined);
      onApplySource(proposal.source);
    }
  });
  const hasIncludes = directives.some(({ target, rule }) =>
    target.kind === "value" && target.enumeration === enumeration && rule?.kind === "role" && rule.includes.length > 0);
  const alert = rejection?.source === source && <p role="alert" className={inline ? "cm-inline-role-note" : "mb-2 text-caption text-refuse"}>{rejection.message}</p>;
  const table = <RoleTable source={source} directives={directives} parsed={parsed} enumeration={enumeration} selected={selected} onToggle={toggle} onNavigate={onNavigate} inline={inline} />;
  // Inline, the table stands where its directive lines were: no heading, no card, one code line per row.
  if (inline) return <>
    {alert}
    {table}
    {hasIncludes && <p className="cm-inline-role-note">Faint checks come from a role included with ...ROLE.</p>}
  </>;
  return <>
    <p className="m-0 text-label font-medium">Role permissions</p>
    <p className="mt-1 mb-2 text-caption text-graphite">
      A check grants the permission within the role’s group.{hasIncludes && " Faint checks come from a role included with ...ROLE."}
    </p>
    {alert}
    {table}
    {toggle && <p className="mt-2 text-caption text-graphite">Arrow keys move between cells. Changes go into the schema draft for review.</p>}
  </>;
}

const actions = { read: "Read", create: "Create", update: "Update", delete: "Delete" } as const;

function SourceLink({ line, onNavigate, children, inline }: { line: number; onNavigate: (line: number) => void; children: ReactNode; inline?: boolean }) {
  // Inline, names read as source identifiers; the link shows itself on hover and focus.
  if (inline) return <button type="button" className="cm-inline-role-link" title={`Go to line ${line} in source`} onClick={() => onNavigate(line)}>{children}</button>;
  return <Button type="button" variant="link" className="font-mono wrap-anywhere" title={`Go to line ${line} in source`} onClick={() => onNavigate(line)}>{children}</Button>;
}

const ladderMoves: Readonly<Record<string, readonly [number, number]>> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

/** Each role's actions and abilities: held itself, from a role it includes, or not at all. */
function RoleTable({ source, directives, parsed, enumeration, selected, onToggle, onNavigate, inline }: {
  source: string; directives: readonly SourceDirective[]; parsed: ParsedAccess; enumeration: string; selected?: string;
  onToggle?: (role: string, item: string) => void; onNavigate: (line: number) => void; inline?: boolean;
}) {
  const graph = parsed.graph.enums[enumeration]!;
  const roles = parsed.policy.enums[enumeration]!.values;
  const index = parsed.index.enums[enumeration]!;
  const holdings = useMemo(() => roleHoldings(directives, parsed, enumeration), [directives, parsed, enumeration]);
  const rowLines = new Map(directives.flatMap(({ target, rule, line }) =>
    target.kind === "enum" && target.enumeration === enumeration && rule?.kind === "permission" ? [[rule.name.text, line] as const] : []));
  const items = rolePermissionItems(graph);
  const uses = (item: string) => {
    const pattern = new RegExp(`\\b${item}\\b`);
    const models = Object.entries(parsed.graph.rules ?? {}).filter(([, rules]) => [...rules.model, ...Object.values(rules.fields).flat()].some((rule) => pattern.test(rule))).map(([name]) => name);
    const commands = Object.entries(parsed.graph.commands).filter(([, command]) => command.who === item).map(([name]) => name);
    return [...models, ...commands.map((name) => `command ${name}`)];
  };
  const [active, setActive] = useState("0:0");
  const move = (event: KeyboardEvent<HTMLTableElement>) => {
    const offset = ladderMoves[event.key];
    const cell = (event.target as HTMLElement).dataset.ladderCell;
    if (!offset || !cell) return;
    const [row, column] = cell.split(":").map(Number);
    const next = `${Math.max(0, Math.min(items.length - 1, row! + offset[0]))}:${Math.max(0, Math.min(roles.length - 1, column! + offset[1]))}`;
    event.preventDefault();
    event.currentTarget.querySelector<HTMLButtonElement>(`button[data-ladder-cell="${next}"]`)?.focus();
  };
  const lines = source.split("\n");
  // The popup is a roomy, touch-sized table; inline, CSS in codemirror.css sets one code line per row.
  const style = inline ? {
    table: "cm-inline-role-table", head: "", corner: "", role: "", body: "", name: "", cell: "", toggle: "cm-inline-role-cell",
  } : {
    table: "w-full border-collapse text-caption",
    head: "border-b border-rule text-graphite",
    corner: "sticky left-0 z-1 bg-sheet py-1 pr-2 text-left font-medium",
    role: "px-2 py-1 text-center font-medium data-selected:text-ink",
    body: "border-b border-rule last:border-0",
    name: "sticky left-0 z-1 bg-sheet py-1 pr-2 text-left font-mono font-normal whitespace-nowrap",
    cell: "px-2 py-1 text-center",
    toggle: "inline-flex size-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 font-medium text-ink hover:bg-wash focus-visible:outline-2 focus-visible:outline-dev aria-disabled:cursor-default",
  };
  return <div className="overflow-x-auto">
    <table className={style.table} aria-label={`${enumeration} roles`} onKeyDown={move}>
      <thead><tr className={style.head}>
        <th scope="col" className={style.corner}>{inline ? <span className="sr-only">Permission</span> : "Permission"}</th>
        {roles.map((role) => <th key={role} scope="col" data-selected={role === selected || undefined} className={style.role}>
          <SourceLink inline={inline} line={accessDirectiveLine(lines, index.values[role]!) ?? index.values[role]!} onNavigate={onNavigate}>
            <span className="whitespace-nowrap">{inline ? role : role.replaceAll("_", " ")}</span>
          </SourceLink>
        </th>)}
      </tr></thead>
      <tbody>{items.map((item, row) => {
        const ability = !(GRAPH_ACTIONS as readonly string[]).includes(item);
        const used = ability ? uses(item) : [];
        return <tr key={item} className={style.body}>
          <th scope="row" data-item={ability ? "ability" : "action"} className={inline ? undefined : `${style.name} ${ability ? "text-access-role" : "font-semibold text-ink"}`}
            title={ability ? (used.length ? `Used by ${used.join(", ")}` : "Not used by any rule or command yet") : `${actions[item as keyof typeof actions]} rows in every model of this role’s scopes`}>
            {rowLines.has(item) ? <SourceLink inline={inline} line={rowLines.get(item)!} onNavigate={onNavigate}>{item}</SourceLink> : item}
          </th>
          {roles.map((role, column) => {
            const own = holdings[role]!.own.includes(item);
            const from = holdings[role]!.inherited[item];
            const cell = `${row}:${column}`;
            const label = own ? `${role} holds ${item}` : from ? `${role} holds ${item} from ${from}` : `${role} does not hold ${item}`;
            return <td key={role} className={style.cell || undefined}>
              {onToggle ? <button type="button" data-ladder-cell={cell} tabIndex={active === cell ? 0 : -1} onFocus={() => setActive(cell)}
                aria-label={`${label}${from ? "" : ". Toggle"}`} aria-pressed={own || !!from} aria-disabled={!!from || undefined}
                title={from ? `${label}. Change it on ${from}.` : label}
                className={style.toggle}
                onClick={() => { if (!from) onToggle(role, item); }}>
                <Mark own={own} inherited={!!from} />
              </button> : <span title={label}><Mark own={own} inherited={!!from} /></span>}
            </td>;
          })}
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

/** Held, held through an included role, or not held: the absent case stays quiet so the pattern of grants reads first. */
function Mark({ own, inherited }: { own: boolean; inherited: boolean }) {
  if (own) return <span aria-hidden data-mark="own" className="font-semibold text-ink">✓</span>;
  if (inherited) return <span aria-hidden data-mark="inherited" className="text-graphite/70">✓</span>;
  return <span aria-hidden data-mark="none" className="text-faint">·</span>;
}
