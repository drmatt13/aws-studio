import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, X } from "lucide-react";
import { GRAPH_ACTIONS } from "aws-studio/database/access-graph";
import { normalizedRule } from "aws-studio/database/access-syntax";
import {
  accessDirectives, describeCondition, type AccessGrant, type AccessModules, type CommandWrite, type GraphModel, type readClientAccess,
  type RowRule, type SourceDirective,
} from "aws-studio/database/client-access";
import { fieldReaderCondition } from "../../shared/database-workbench";
import { Button, buttonClasses } from "../ui/Button";
import { Select } from "../ui/FormControls";
import { IconButton } from "../ui/IconButton";
import { AccessRuleForm } from "./AccessRuleForm";
import { AccessCode } from "./AccessCode";
import { InspectorDisclosure } from "./InspectorUI";
import { accessDirectiveLine } from "./access-authoring";
import { RolePermissionMatrix } from "./RolePermissionMatrix";
import { fieldAccessSummary, grantSummary } from "./access-inspector-summary";
import { personas, sampleReadAccess, sampleReadFields, type ScenarioState } from "./access-lens";
import type { ScopeKind } from "./prisma-access-language";

type ParsedAccess = ReturnType<typeof readClientAccess>;
export type AccessSelection = { readonly kind: "model" | "enum"; readonly name: string; readonly line: number; readonly member?: string };

export interface PrismaAccessInspectorProps {
  readonly source: string;
  readonly parsed: ParsedAccess;
  readonly line: number;
  readonly activeLine?: number;
  /** Source inventory of registered Prisma-backed GraphQL object types. */
  readonly exposure?: {
    readonly status: "loading" | "unavailable" | "available";
    readonly typesByModel?: Readonly<Record<string, readonly string[]>>;
  };
  readonly policyModuleHref?: string;
  readonly modules?: AccessModules;
  readonly onApplySource?: (next: string) => void;
  readonly onNavigate: (line: number) => void;
  /** Puts the cursor in the source at the authored rule. */
  readonly onEditSource?: (line: number, offset?: number) => void;
  readonly onClose: () => void;
}

const code = "font-mono wrap-anywhere";
const quiet = "text-caption text-graphite";
const section = "border-b border-rule px-4 py-3";
const actions = { read: "Read", create: "Create", update: "Update", delete: "Delete" } as const;
const dot: Readonly<Record<ScopeKind, string>> = { identity: "bg-access-identity", role: "bg-access-role", path: "bg-access-path" };

export function accessSelectionAt(lines: readonly string[], { index }: ParsedAccess, line: number): AccessSelection | undefined {
  if (/^\s*\/\/\//.test(lines[line - 1] ?? "")) {
    while (/^\s*\/\/\//.test(lines[line - 1] ?? "")) line++;
  }
  for (const [name, model] of Object.entries(index.models)) {
    if (line < model.line || line > model.end) continue;
    const member = Object.entries(model.fields).find(([, at]) => at === line)?.[0];
    return { kind: "model", name, line: member ? line : model.line, member };
  }
  for (const [name, enumeration] of Object.entries(index.enums)) {
    if (line < enumeration.line || line > enumeration.end) continue;
    const member = Object.entries(enumeration.values).find(([, at]) => at === line)?.[0];
    return { kind: "enum", name, line: member ? line : enumeration.line, member };
  }
  return undefined;
}

function SourceLink({ line, onNavigate, children, identifier }: {
  line: number; onNavigate: PrismaAccessInspectorProps["onNavigate"]; children: ReactNode; identifier?: boolean;
}) {
  return <Button type="button" variant="link" className={identifier ? code : undefined} title={`Go to line ${line} in source`} onClick={() => onNavigate(line)}>{children}</Button>;
}

function PolicyModuleLink({ href }: { href?: string }) {
  return href ? <a className={buttonClasses({ variant: "link" })} href={href}>Open policy module</a> : null;
}

function ScopeDot({ kind }: { kind: ScopeKind }) {
  return <span aria-hidden className={`mt-[5px] inline-block size-[7px] shrink-0 rounded-full ${dot[kind]}`} />;
}

function ModelExposure({ model, exposure }: Pick<PrismaAccessInspectorProps, "exposure"> & { model: string }) {
  let detail = "GraphQL exposure unavailable";
  if (exposure?.status === "loading") detail = "Checking GraphQL exposure…";
  if (exposure?.status === "available") {
    const types = exposure.typesByModel?.[model] ?? [];
    detail = types.length ? `GraphQL types · ${types.join(", ")}` : "No registered GraphQL table type";
  }
  return <p className={quiet}>{detail}</p>;
}

function SampleRead({ parsed, model, field }: { parsed: ParsedAccess; model: string; field?: string }) {
  const choices = useMemo(() => {
    const scope = parsed.graph.models[model]?.scope;
    return personas(parsed).filter(({ persona }) => persona.kind === "owner" ? !scope : persona.kind === "stranger" || !scope || persona.group === scope);
  }, [parsed, model]);
  const [choice, setChoice] = useState(() => choices.find(({ persona }) => persona.kind === "role")?.id ?? choices[0]?.id);
  const selected = choices.find(({ id }) => id === choice) ?? choices[0];
  const fields = useMemo(() => sampleReadFields(parsed, model), [parsed, model]);
  const [values, setValues] = useState<Readonly<Record<string, number>>>({});
  const [verdict, setVerdict] = useState<Awaited<ReturnType<typeof sampleReadAccess>> | "error">();
  // Open disclosures mount the evaluation on demand. A state change replaces its pending result.
  useEffect(() => {
    let current = true;
    const states: Record<string, ScenarioState> = {};
    for (const item of fields) {
      const value = item.values[values[`${item.model}.${item.field}`] ?? 0];
      if (value !== undefined) states[item.model] = { ...states[item.model], [item.field]: value };
    }
    setVerdict(undefined);
    if (selected) void sampleReadAccess(parsed, model, selected.persona, states, field).then((answer) => {
      if (current) setVerdict(answer);
    }, () => {
      if (current) setVerdict("error");
    });
    return () => { current = false; };
  }, [parsed, model, field, selected, fields, values]);

  return <div className="grid gap-2">
    <label className="grid gap-1 text-caption font-medium">
      Reader
      <Select className="w-full" value={selected?.id ?? ""} onChange={(event) => setChoice(event.target.value)}>
        {choices.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </Select>
    </label>
    {fields.map((item) => {
      const key = `${item.model}.${item.field}`;
      return <label key={key} className="grid gap-1 text-caption font-medium">
        <span className={code}>{key}</span>
        <Select className="w-full" value={item.values[values[key] ?? 0] === undefined ? 0 : values[key] ?? 0}
          onChange={(event) => setValues({ ...values, [key]: Number(event.target.value) })}>
          {item.symbols.map((symbol, index) => <option key={symbol} value={index}>{symbol}</option>)}
        </Select>
      </label>;
    })}
    <div role="status">
      <p className="text-label font-medium">
        {verdict === undefined ? "Evaluating sample…" : verdict === "error" ? "Sample could not be evaluated" : verdict.allowed ? "Can read this sample" : "Cannot read this sample"}
      </p>
      {verdict && verdict !== "error" && verdict.reason && <p className={`${quiet} mt-0.5`}>{verdict.reason}</p>}
    </div>
    <p className={quiet}>Uses sample rows and memberships.</p>
  </div>;
}

function Preview({ parsed, selection }: { parsed: ParsedAccess; selection: AccessSelection }) {
  const [open, setOpen] = useState(false);
  const field = selection.member && !parsed.policy.models[selection.name]?.fields[selection.member]?.relation ? selection.member : undefined;
  return <InspectorDisclosure title="Preview with sample data" open={open} onToggle={setOpen}>
    {open && <SampleRead parsed={parsed} model={selection.name} field={field} />}
  </InspectorDisclosure>;
}

function Commands({ commands, href, onNavigate }: { commands: readonly { name: string; who: string; write: CommandWrite; line?: number }[]; href?: string; onNavigate: (line: number) => void }) {
  return <InspectorDisclosure title="Commands" count={commands.length}>
    <ul className="grid gap-3">
      {commands.map(({ name, who, write, line }, index) => <li key={`${name}:${index}`}>
        <p className={code}>{line ? <SourceLink identifier line={line} onNavigate={onNavigate}>{name}</SourceLink> : name}</p>
        <p className={quiet}>{actions[write.verb]} · {who === "authenticated" ? "Signed-in users" : who}
          {write.when && <> · {Object.entries(write.when).map(([key, value]) => describeCondition(key, value)).join(" and ")}</>}</p>
        {!!write.fields?.length && <p className={quiet}>Fields · <span className={code}>{write.fields.join(", ")}</span></p>}
        {write.to && <p className={quiet}>Values · {Object.entries(write.to).map(([key, value]) => describeCondition(key, value)).join(" and ")}</p>}
      </li>)}
    </ul>
    {href && commands.some(({ line }) => !line) && <p className="mt-3 text-caption"><PolicyModuleLink href={href} /></p>}
  </InspectorDisclosure>;
}

const commandsFor = (parsed: ParsedAccess, model: string, field?: string) => Object.entries(parsed.graph.commands).flatMap(([name, command]) =>
  command.writes.filter((write) => write.model === model && (!field || write.fields?.includes(field))).map((write) => ({
    name, who: command.who, write, line: parsed.graph.provenance.commands?.[name]?.find(location => location.model === model && location.verb === write.verb)?.line,
  })));

function protection(parsed: ParsedAccess, model: string, field: string): string | undefined {
  const graph = parsed.graph.models[model]?.fields[field];
  const mode = parsed.settings[model]?.[field];
  if (mode === "server-only") return "Server only";
  if (graph === "actor") return "Server-controlled identity";
  if (mode === "read-only") return "Read only";
  if (parsed.policy.models[model]?.fields[field]?.link) return "Access link";
}

function FieldProtections({ parsed, model, onNavigate }: { parsed: ParsedAccess; model: string; onNavigate: PrismaAccessInspectorProps["onNavigate"] }) {
  const fields = Object.entries(parsed.index.models[model]?.fields ?? {}).flatMap(([name, line]) => {
    const mode = protection(parsed, model, name);
    const identity = parsed.policy.models[model]?.fields[name]?.readIdentity;
    const detail = [mode, identity && fieldReaderCondition(model, identity)].filter(Boolean).join(" · ");
    return detail ? [{ name, line, detail }] : [];
  });
  if (!fields.length) return null;
  return <InspectorDisclosure title="Field protections" count={fields.length}>
    <ul className="grid gap-1 text-caption">{fields.map(({ name, line, detail }) => <li key={name} className="flex flex-wrap items-baseline justify-between gap-x-2">
      <SourceLink identifier line={line} onNavigate={onNavigate}>{name}</SourceLink>
      <span className="text-graphite">{detail}</span>
    </li>)}</ul>
  </InspectorDisclosure>;
}

/** The directives written above a declaration, coloured, each linked to its line. */
function Directives({ directives, onEditSource }: { directives: readonly SourceDirective[]; onEditSource: (line: number) => void }) {
  return <ul className="m-0 grid list-none gap-1.5 p-0">
    {directives.map((directive) => <li key={directive.line} className="flex items-baseline justify-between gap-2">
      <AccessCode text={directive.problem ? directive.args : normalizedRule(directive.args)} placement={directive.target.kind === "value" ? "value" : directive.target.kind} />
      <Button type="button" variant="link" className="shrink-0 text-caption" aria-label={`Show line ${directive.line} in source`} onClick={() => onEditSource(directive.line)}>{directive.line}</Button>
    </li>)}
  </ul>;
}

const directivesOf = (directives: readonly SourceDirective[], model: string, field?: string) => directives.filter(({ target, rule }) => {
  if (!("model" in target) || target.model !== model) return false;
  if (!field) return target.kind === "model" && rule?.kind !== "fieldGroup" && rule?.kind !== "command";
  return target.kind === "field" ? target.field === field
    : rule?.kind === "fieldGroup" && rule.columns.some(({ text }) => text === field);
});

function GroupedFields({ directives, model, onEditSource }: { directives: readonly SourceDirective[]; model: string; onEditSource: (line: number) => void }) {
  const groups = directives.filter(({ target, rule }) => target.kind === "model" && target.model === model && rule?.kind === "fieldGroup");
  if (!groups.length) return null;
  return <section className={section} aria-label="Grouped field rules">
    <p className="mb-1.5 text-label font-medium">Grouped field rules</p>
    <Directives directives={groups} onEditSource={onEditSource} />
  </section>;
}

/** Who sees a model's rows, one line per path, coloured by where it comes from. */
function readers(parsed: ParsedAccess, model: string): { kind: ScopeKind; text: string }[] {
  const row = parsed.rows.models[model];
  if (!row) return [];
  const lines: { kind: ScopeKind; text: string }[] = [];
  const when = (filter: Readonly<Record<string, unknown>> | undefined) => {
    const parts = Object.entries(filter ?? {}).map(([key, value]) => describeCondition(key, value as never));
    return parts.length ? ` when ${parts.join(" and ")}` : "";
  };
  if (row.self) lines.push({ kind: "identity", text: "Each signed-in user, their own row" });
  if (row.authenticated) lines.push({ kind: "identity", text: "Every signed-in user" });
  for (const rule of row.rules as readonly RowRule[]) {
    if (rule.kind === "owner") lines.push({ kind: "identity", text: "relation" in rule ? `The user in ${rule.fields.join(", ")}` : `The user whose ${rule.field} it is` });
    else if (rule.kind === "members") lines.push({ kind: "role", text: `Members through ${rule.relation}${when(rule.where)}${when(rule.own)}` });
    else if (rule.who?.length) lines.push({ kind: "role", text: `${rule.who.includes("member") ? "Members" : rule.who.join(" or ")} of the related ${rule.model}${when(rule.where)}${when(rule.own)}` });
    else lines.push({ kind: "path", text: `Whoever reads the related ${rule.model} (${rule.relation})${when(rule.where)}${when(rule.own)}` });
  }
  return lines;
}

function Readers({ parsed, model }: { parsed: ParsedAccess; model: string }) {
  const list = readers(parsed, model);
  return <ul aria-label="Who sees rows" className="m-0 grid list-none gap-1 p-0 text-caption">
    {list.map(({ kind, text }, index) => <li key={index} className="flex items-start gap-2"><ScopeDot kind={kind} /><span>{text}</span></li>)}
  </ul>;
}

function EffectiveModel({ source, parsed, directives, selection, graph, exposure, onNavigate, onEditSource, policyModuleHref }: Pick<PrismaAccessInspectorProps, "source" | "parsed" | "exposure" | "onNavigate" | "policyModuleHref"> & {
  directives: readonly SourceDirective[]; selection: AccessSelection; graph: GraphModel; onEditSource: (line: number) => void;
}) {
  const model = selection.name;
  const lines = source.split("\n");
  const field = selection.member;
  const fieldDeclaration = field ? parsed.policy.models[model]?.fields[field] : undefined;
  const root = parsed.graph.models[graph.path[graph.path.length - 1]!];
  const proof = (name: string) => parsed.graph.provenance.models[name]?.line ?? parsed.index.models[name]!.line;
  const granted = GRAPH_ACTIONS.filter((action) => graph.actions[action].length > 0);
  const caps = graph.path.flatMap((name) => parsed.graph.models[name]?.only ? [[name, parsed.graph.models[name]!.only!] as const] : []);
  const denies = graph.guards.flatMap(({ model: origin }) => directives.filter(({ target, rule }) => target.kind === "model" && target.model === origin && rule?.kind === "deny"));
  const commands = commandsFor(parsed, model, field);
  const fieldProtection = field ? protection(parsed, model, field) : undefined;
  const memberships = root?.roles;
  return <>
    <section className={section}>
      <ol aria-label="Access path" className="m-0 mb-2 flex list-none flex-wrap items-center gap-x-1.5 gap-y-1 p-0 text-caption">
        {graph.path.map((name, index) => <li className="inline-flex items-center gap-1.5" key={name}>
          {index > 0 && <ArrowRight size={12} className="shrink-0 text-access-path" aria-hidden />}
          {index === 0 && !field ? <span className={code}>{name}</span> : <SourceLink identifier line={proof(name)} onNavigate={onNavigate}>{name}</SourceLink>}
        </li>)}
      </ol>
      {memberships ? <p className="flex items-start gap-2 text-label"><ScopeDot kind="role" /><span>
        {Object.values(memberships.filter ?? {}).includes("ACTIVE") ? "Your ACTIVE membership’s role" : "Your membership’s role"}
        {" · "}<SourceLink identifier line={parsed.index.enums[memberships.enumeration]!.line} onNavigate={onNavigate}>{memberships.enumeration}</SourceLink>
      </span></p> : root?.identity && <p className="flex items-start gap-2 text-label"><ScopeDot kind="identity" /><span className={code}>{root.identity.map(field => `isMe(${field})`).join(" || ")}</span></p>}
      {memberships && <p className={`${quiet} mt-1`}>
        <SourceLink identifier line={parsed.index.models[memberships.membership]!.line} onNavigate={onNavigate}>{memberships.membership}</SourceLink>
        {Object.entries(memberships.filter ?? {}).map(([name, value]) => <span className={code} key={name}> · {name} = {value}</span>)}
      </p>}
      <p className="mt-3 text-label font-medium">Role actions here · {granted.length === 1 && granted[0] === "read" ? "Read only" : granted.length ? granted.map((action) => actions[action]).join(", ") : "None"}</p>
      {!field && <ModelExposure model={model} exposure={exposure} />}
      {denies.length > 0 && <div className="mt-2 grid gap-1 border-l-2 border-access-limit/50 pl-2">
        <p className="text-caption font-medium">Deny always wins</p>
        <Directives directives={denies} onEditSource={onEditSource} />
        {denies.some(({ target }) => target.kind === "model" && target.model !== model) && <p className={quiet}>Inherited through from:.</p>}
      </div>}
      <div className="mt-3"><Directives directives={directivesOf(directives, model)} onEditSource={onEditSource} /></div>
    </section>
    {field && <section className={section}>
      <p className="text-label font-medium">{fieldProtection ?? (fieldDeclaration?.relation ? "Relation" : "Role actions apply")}</p>
      {fieldDeclaration?.readIdentity && <p className={quiet}>Readers must see the row and match <code>{fieldReaderCondition(model, fieldDeclaration.readIdentity)}</code>.</p>}
      {fieldProtection === "Access link" && <p className={quiet}>This field sets the row’s access path and stays fixed after creation.</p>}
      <div className="mt-1"><Directives directives={directivesOf(directives, model, field)} onEditSource={onEditSource} /></div>
      <p className="mt-1 text-caption"><SourceLink onNavigate={onNavigate} line={accessDirectiveLine(lines, selection.line) ?? selection.line}>Show field declaration</SourceLink></p>
    </section>}
    {!field && <GroupedFields directives={directives} model={model} onEditSource={onEditSource} />}
    {!!commands.length && <Commands commands={commands} href={policyModuleHref} onNavigate={onEditSource} />}
    {!!caps.length && <InspectorDisclosure title="Action caps">
      <ul className="grid gap-1 text-caption">{caps.map(([name, only]) => <li key={name}>
        <SourceLink identifier line={proof(name)} onNavigate={onNavigate}>{name}</SourceLink> caps role actions at {only.map((action) => actions[action]).join(", ").toLowerCase()}.
      </li>)}</ul>
    </InspectorDisclosure>}
    {!field && <FieldProtections parsed={parsed} model={model} onNavigate={onNavigate} />}
    <Preview key={`${model}.${field ?? ""}`} parsed={parsed} selection={selection} />
  </>;
}

/** A model whose rules say who may do what: who sees rows, the rules as written, writes and protections. */
function RuleModel({ source, parsed, directives, selection, exposure, onNavigate, onEditSource, policyModuleHref }: Pick<PrismaAccessInspectorProps, "source" | "parsed" | "exposure" | "onNavigate" | "policyModuleHref"> & {
  directives: readonly SourceDirective[]; selection: AccessSelection; onEditSource: (line: number) => void;
}) {
  const model = selection.name;
  const field = selection.member;
  const declaration = parsed.policy.models[model];
  const summary = field && declaration?.fields[field] && !declaration.fields[field]!.relation ? fieldAccessSummary(source, parsed, model, field) : undefined;
  const own = field ? directivesOf(directives, model, field) : [];
  const commands = commandsFor(parsed, model, field);
  const writes = (["create", "update", "delete"] as const).flatMap((verb) => declaration?.[verb] ? [[verb, declaration[verb]!] as const] : []);
  return <>
    <section className={section}>
      <p className="mb-1.5 text-label font-medium">Who sees rows</p>
      <Readers parsed={parsed} model={model} />
      {!field && <div className="mt-2"><ModelExposure model={model} exposure={exposure} /></div>}
      <div className="mt-3"><Directives directives={directivesOf(directives, model)} onEditSource={onEditSource} /></div>
    </section>
    {summary && <section className={section}>
      <p className="text-label font-medium">{summary.headline}</p>
      {own.length > 0 && <div className="mt-2"><Directives directives={own} onEditSource={onEditSource} /></div>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
        <dt className="font-medium">Read</dt><dd className="text-graphite">{summary.read}</dd>
        <dt className="font-medium">Create</dt><dd className="text-graphite">{summary.create}</dd>
        <dt className="font-medium">Update</dt><dd className="text-graphite">{summary.update}</dd>
      </dl>
    </section>}
    {!field && <GroupedFields directives={directives} model={model} onEditSource={onEditSource} />}
    {!field && <section className={section}>
      <p className="mb-1 text-label font-medium">Writes</p>
      {writes.length ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
        {writes.map(([verb, grants]) => <Write key={verb} verb={verb} grants={grants} />)}
      </dl> : <p className={quiet}>No rule lets clients create, update or delete rows. Fields may still have write rules of their own.</p>}
    </section>}
    {!!commands.length && <Commands commands={commands} href={policyModuleHref} onNavigate={onEditSource} />}
    {!field && <FieldProtections parsed={parsed} model={model} onNavigate={onNavigate} />}
    <Preview key={`${model}.${field ?? ""}`} parsed={parsed} selection={selection} />
  </>;
}

function Write({ verb, grants }: { verb: "create" | "update" | "delete"; grants: readonly AccessGrant[] }) {
  return <><dt className="font-medium">{actions[verb]}</dt><dd className="text-graphite">{grantSummary(grants, "No one")}</dd></>;
}

function EnumAccess({ parsed, directives, selection, source, modules, onApplySource, onNavigate, onEditSource, form }: Pick<PrismaAccessInspectorProps,
  "parsed" | "source" | "modules" | "onApplySource" | "onNavigate"> & { directives: readonly SourceDirective[]; selection: AccessSelection; onEditSource: (line: number) => void; form: ReactNode }) {
  const graph = parsed.graph.enums[selection.name];
  const index = parsed.index.enums[selection.name]!;
  const roleEnum = !!graph && (Object.keys(graph.masks).length > 0 || Object.keys(graph.permissions).length > 0);
  const selectedPermissions = selection.member && graph ? Object.entries(graph.permissions).filter(([, roles]) => roles.includes(selection.member!)).map(([permission]) => permission) : [];
  const scopes = Object.entries(parsed.graph.models).flatMap(([scope, model]) =>
    model.roles?.enumeration === selection.name ? [{ scope, ...model.roles }] : []);
  const memberDirectives = selection.member ? directives.filter(({ target }) => target.kind === "value" && target.enumeration === selection.name && target.value === selection.member) : [];
  return <>
    {selection.member && form}
    <section className={section}>
      {roleEnum ? <RolePermissionMatrix source={source} parsed={parsed} directives={directives}
        enumeration={selection.name} selected={selection.member} modules={modules} onApplySource={onApplySource} onNavigate={onNavigate} />
        : <p className="text-label font-medium">{graph?.unassignable.length ? "Protected values only" : "No roles declared"}</p>}
    </section>
    {!selection.member && form}
    {(scopes.length > 0 || !!graph?.unassignable.length) && <section className={section}>
      <p className="text-label font-medium">Role assignment</p>
      {scopes.map(({ scope, membership, field, filter }) => {
        const fieldLine = parsed.index.models[membership]!.fields[field]!;
        const writes = parsed.policy.models[membership]?.fields[field]?.write;
        return <div key={scope} className="mt-1 text-caption">
          <p className="flex items-start gap-2"><ScopeDot kind="role" /><span><SourceLink identifier line={fieldLine} onNavigate={onNavigate}>{membership}.{field}</SourceLink> in each {scope}</span></p>
          {filter && <p className={quiet}>Counts while {Object.entries(filter).map(([key, value]) => describeCondition(key, value)).join(" and ")}.</p>}
          {writes && <p className={quiet}>Changed by {grantSummary(writes, "no one")}.</p>}
        </div>;
      })}
      {!!graph?.unassignable.length && <p className={`${quiet} mt-2`}>Clients never assign or replace {graph.unassignable.map((role, i) =>
        <span key={role}>{i > 0 && ", "}<SourceLink identifier line={accessDirectiveLine(source.split("\n"), index.values[role]!) ?? index.values[role]!} onNavigate={onNavigate}>{role}</SourceLink></span>
      )} <span className="text-access-limit">(protected)</span>.</p>}
    </section>}
    {memberDirectives.length > 0 && <section className={section}>
      <Directives directives={memberDirectives} onEditSource={onEditSource} />
    </section>}
    {selection.member && roleEnum && <section className={section}>
      <p className="text-label font-medium">{selection.member} permissions</p>
      <p className={quiet}>{[...(graph.masks[selection.member] ?? []), ...selectedPermissions].join(", ") || "None"}</p>
    </section>}

  </>;
}

export function PrismaAccessInspector(props: PrismaAccessInspectorProps) {
  const { source, parsed, line, onNavigate, onEditSource, onClose } = props;
  const directives = useMemo(() => accessDirectives(source), [source]);
  const selection = accessSelectionAt(source.split("\n"), parsed, line);
  const graph = selection?.kind === "model" ? parsed.graph.models[selection.name] : undefined;
  const ruled = selection?.kind === "model" && !graph && !!parsed.rows.models[selection.name];
  const invalid = parsed.problems[0];
  const governed = directives.length > 0 || props.modules !== undefined;
  const title = selection ? [selection.name, selection.member].filter(Boolean).join(".") : "Access";
  const editSource = (target: number) => (onEditSource ?? onNavigate)(target);
  const kind = selection?.kind === "enum" ? "Roles" : graph ? graph.base === "roles" ? "Role scope" : graph.base === "from" ? "In a role scope" : "Owner’s rows" : ruled ? "Rules" : governed ? "Not in the API" : "No policy declared";

  const target: SourceDirective["target"] | undefined = selection?.kind === "model"
    ? selection.member ? { kind: "field", model: selection.name, field: selection.member } : { kind: "model", model: selection.name }
    : selection?.kind === "enum"
      ? selection.member ? { kind: "value", enumeration: selection.name, value: selection.member } : { kind: "enum", enumeration: selection.name }
      : undefined;
  const form = target && props.onApplySource && <AccessRuleForm source={source} parsed={parsed} modules={props.modules}
    target={target} activeLine={props.activeLine} onApplySource={props.onApplySource} />;

  return <section aria-label="Prisma access inspector" data-ui="prisma-access-inspector" className="flex min-h-0 min-w-0 flex-col bg-sheet">
    <header className="flex shrink-0 items-start justify-between gap-2 border-b border-rule px-4 py-3">
      <div className="min-w-0">
        {selection && <p className={`m-0 ${quiet}`}>Access · {kind}</p>}
        <h2 className={`m-0 mt-0.5 wrap-anywhere text-[1rem] font-semibold ${selection ? code : ""}`}>{title}</h2>
      </div>
      <IconButton type="button" variant="quiet" aria-label="Close access inspector" data-ui="prisma-access-inspector-close" onClick={onClose}>
        <X size={16} aria-hidden />
      </IconButton>
    </header>
    <div className="min-h-0 overflow-y-auto overscroll-contain">
      {!invalid && selection?.kind === "model" && form}
      {invalid ? <div className={section}>
        <p className="text-label font-medium">Fix the access rules to inspect the policy.</p>
        <p className="mt-1 text-caption text-refuse">{invalid.message}</p>
        <p className="mt-2 text-caption"><SourceLink line={invalid.line} onNavigate={onNavigate}>Go to line {invalid.line}</SourceLink></p>
      </div> : !selection ? <p className="px-4 py-3 text-label text-graphite">Select a model, field, or role enum in the source.</p>
        : selection.kind === "enum" ? <EnumAccess {...props} key={selection.name} directives={directives} selection={selection} onEditSource={editSource} form={form} />
          : graph ? <EffectiveModel {...props} key={title} directives={directives} selection={selection} graph={graph} onEditSource={editSource} />
            : ruled ? <RuleModel {...props} key={title} directives={directives} selection={selection} onEditSource={editSource} />
              : <>
                <section className={section}>
                  <p className="text-label font-medium">{governed ? `${selection.name} is not in the client API.` : "No Access Graph policy declared."}</p>
                  <p className={`${quiet} mt-1`}>{governed ? "Client exposure requires a row read rule or a scope above the model." : "API exposure and authorization remain defined by the application's resolvers and repositories."}</p>
                  {selection.member && <Directives directives={directivesOf(directives, selection.name, selection.member)} onEditSource={editSource} />}
                </section>
                {!selection.member && <GroupedFields directives={directives} model={selection.name} onEditSource={editSource} />}
              </>}
    </div>
  </section>;
}
