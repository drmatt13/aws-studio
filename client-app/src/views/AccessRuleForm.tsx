import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { accessDirectives, type AccessModules, type readClientAccess, type SourceDirective } from "aws-studio/database/client-access";
import { Button } from "../ui/Button";
import { Select, Textarea, TextInput } from "../ui/FormControls";
import { setAccessRule } from "./access-authoring";

type Target = SourceDirective["target"];
type Parsed = ReturnType<typeof readClientAccess>;

interface Props {
  source: string;
  parsed: Parsed;
  modules?: AccessModules;
  target: Target;
  activeLine?: number;
  onApplySource: (source: string) => void;
}

function matches(a: Target, b: Target): boolean {
  switch (a.kind) {
    case "model": return b.kind === "model" && b.model === a.model;
    case "enum": return b.kind === "enum" && b.enumeration === a.enumeration;
    case "field": return b.kind === "field" && b.model === a.model && b.field === a.field;
    case "value": return b.kind === "value" && b.enumeration === a.enumeration && b.value === a.value;
  }
}

/** Common rules built from this declaration's actual Prisma keys and relations. */
function suggestions(parsed: Parsed, target: Target, modules?: AccessModules) {
  const options = new Map<string, string>();
  if (target.kind === "value") return new Map([
    ["protected", "Server-assigned value"], ["read", "Scoped read"], ["read, protected", "Scoped read and server-assigned value"],
  ]);
  if (target.kind === "enum") return options;
  const model = parsed.policy.models[target.model];
  if (!model) return options;
  const isField = target.kind === "field";
  if (isField) {
    options.set("readonly", "Read-only field");
    options.set("serverOnly", "Server-only field");
  }
  const principal = parsed.rows.userModel ?? modules?.principal ?? "User";
  const key = parsed.rows.models[principal]?.key;
  const identities = new Set<string>();
  if (target.model === principal && key?.length === 1) identities.add(key[0]!);
  for (const [name, relation] of Object.entries(model.fields)) {
    if (!relation.relation) continue;
    if (!relation.list && relation.type === principal && relation.local?.length === 1 && key?.length === 1 && relation.target?.[0] === key[0]) {
      identities.add(relation.local[0]!);
    }
    const related = parsed.graph.models[relation.type];
    if (!isField && !relation.list && related) options.set(`from: ${name}`, `Inherit access from ${name}`);
    if (!isField && parsed.rows.models[relation.type]) options.set(`read: ${name}.read`, `Allow readers of ${name}`);
    if (relation.list || !related?.enumeration) continue;
    for (const permission of Object.keys(parsed.policy.enums[related.enumeration]?.grants ?? {})) {
      const action = isField ? "write" : "update";
      options.set(`${action}: ${name}.${permission}`, `${isField ? "Write" : "Update"} with ${name}.${permission}`);
    }
  }
  for (const field of identities) options.set(`read: isMe(${field})`, `Read when ${field} is me`);
  return options;
}

export function AccessRuleForm(props: Props) {
  const { source, parsed, target, activeLine } = props;
  const directives = useMemo(() => accessDirectives(source).filter((item) => matches(item.target, target)), [source, target]);
  if (target.kind === "field" && parsed.policy.models[target.model]?.fields[target.field]?.relation) return null;
  const clicked = directives.findIndex((item) => activeLine !== undefined && item.line <= activeLine && activeLine <= item.endLine);
  // A matrix edit can change the selected directive while this form is open.
  const key = JSON.stringify([target, clicked, directives.map(({ args }) => args)]);
  return <RuleEditor key={key} {...props} directives={directives} clicked={clicked} />;
}

function RuleEditor({ source, parsed, modules, target, onApplySource, directives, clicked }: Props & { directives: SourceDirective[]; clicked: number }) {
  const initial = clicked >= 0 ? clicked : directives.length === 1 ? 0 : -1;
  const [index, setIndex] = useState(initial);
  const current = directives[index];
  const [text, setText] = useState(current?.args.trim() ?? "");
  const [permissionName, setPermissionName] = useState("");
  const [removing, setRemoving] = useState(false);
  const [open, setOpen] = useState(target.kind !== "enum" && (clicked >= 0 || directives.length === 0));
  const options = useMemo(() => suggestions(parsed, target, modules), [parsed, target, modules]);
  const newPermission = target.kind === "enum" && !current;
  const rule = newPermission ? permissionName && `${permissionName}: []` : text.trim();
  const changed = removing || (!!rule && rule !== current?.args.trim());
  const proposed = useMemo(() => changed ? setAccessRule(source, target, current, removing ? null : rule, modules) : undefined,
    [source, target, current, changed, rule, removing, modules]);
  const choose = (next: number) => {
    setIndex(next);
    setText(directives[next]?.args.trim() ?? "");
    setRemoving(false);
    setPermissionName("");
  };
  const apply = () => {
    if (!proposed || proposed.problem) return;
    onApplySource(proposed.source);
    setOpen(false);
    setRemoving(false);
    setIndex(-1);
    setText("");
    setPermissionName("");
  };
  return <section className="border-b border-rule px-4 py-2.5" data-ui="access-rule-form">
    <button type="button" className="flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-label font-medium text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ChevronRight size={14} aria-hidden className={open ? "rotate-90" : ""} />Configure access
    </button>
    {open && <div className="mt-3 grid gap-2.5 text-caption">
      {directives.length > 0 && <label className="grid min-w-0 gap-1">Rule
        <Select value={current ? index : -1} onChange={(e) => choose(Number(e.target.value))}>
          <option value={-1}>Add a rule</option>
          {directives.map((item, i) => <option key={item.line} value={i}>{item.args.trim().replace(/\s+/g, " ")}</option>)}
        </Select>
      </label>}
      {removing ? <p role="status">Remove this rule from the draft?</p> : newPermission ? <label className="grid gap-1">Permission name
        <TextInput value={permissionName} placeholder="approveNotes" onChange={(e) => setPermissionName(e.target.value)} />
        <span className="text-graphite">Select its holders in the matrix after adding it.</span>
      </label> : <>
        {options.size > 0 && <label className="grid gap-1">Quick configuration
          <Select value={options.has(text) ? text : ""} onChange={(e) => setText(e.target.value)}>
            <option value="" disabled>Choose a rule</option>
            {[...options].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>}
        <label className="grid gap-1">Access expression
          <Textarea spellCheck={false} value={text} rows={2} className="font-mono" onChange={(e) => setText(e.target.value)} />
        </label>
      </>}
      {proposed?.problem && <p role="status" className="text-refuse">{proposed.problem}</p>}
      {current && changed && !removing && <p className="break-words text-graphite">Replaces <code>{current.args.trim()}</code></p>}
      <div className="flex items-center justify-between gap-2">
        {current ? <Button size="compact" variant="link" tone="danger" onClick={() => setRemoving(!removing)}>{removing ? "Keep rule" : "Remove rule"}</Button> : <span />}
        <Button size="compact" variant="primary" disabled={!proposed || !!proposed.problem} onClick={apply}>Apply to draft</Button>
      </div>
    </div>}
  </section>;
}
