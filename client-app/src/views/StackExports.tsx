import type { ModelResource } from "../../shared/model";
import { inspectorIntroClasses, inspectorRelationListClasses } from "../inspector-ui";
import { resourceIcon } from "../icons";
import { catalogReference, displayName } from "../naming";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { EntityIcon } from "./EntityIcon";
import { InspectorDisclosure, InspectorResourceRow } from "./InspectorUI";

type StackOutput = NonNullable<ModelResource["stackOutputs"]>[number];
interface ExportRow {
  readonly key: string;
  readonly member?: ModelResource;
  readonly outputs: StackOutput[];
}

/** Public stack values and CDK outputs share one list; matching fields appear once. */
export function StackExports({ stack }: { readonly stack: ModelResource }) {
  const { model, select } = useStudio();
  const members = model.resources.filter(resource => resource.parent === stack.id);
  const rows: ExportRow[] = members.filter(member => member.nativeKind === "value")
    .map(member => ({ key: member.id, member, outputs: [] }));
  const fields = new Map(rows.map(row => [row.member!.path.at(-1)!, row]));
  for (const output of stack.stackOutputs ?? []) {
    const field = fields.get(output.symbol);
    if (field) field.outputs.push(output);
    else rows.push({ key: `output:${output.name}`, outputs: [output] });
  }
  if (!rows.length) return null;
  return (
    <InspectorDisclosure title="Exports" count={rows.length} data-slot="stack-exports">
      <p className={inspectorIntroClasses}>
        Values exposed by this CDK stack. Use stack references in workload configuration alongside parameters and secrets.
      </p>
      <ul className={inspectorRelationListClasses}>
        {rows.map(row => {
          const output = row.outputs[0];
          const symbol = row.member?.path.at(-1) ?? output!.symbol;
          const exposed = members.some(member => member.path.at(-1) === symbol.split(".")[0]);
          const reference = !stack.frameworkStack && exposed ? `${catalogReference(model, stack.id)}.${symbol}` : undefined;
          return (
            <InspectorResourceRow
              key={row.key}
              data-slot="stack-export"
              icon={<EntityIcon size={26} icon={resourceIcon(row.member ?? stack)} />}
              title={row.member ? (
                <button className={buttonClasses({ variant: "link" })} onClick={() => select(row.member!.id)}>
                  {displayName(model, row.member.id, row.member.path.at(-1)!)}
                </button>
              ) : output!.name}
            >
              <span>{reference ? "Reference" : "CDK value"} · <code data-slot="stack-export-reference">{reference ?? symbol}</code></span>
              {row.outputs.map(item => (
                <span key={item.name} className="grid gap-0.5" data-slot="stack-export-output">
                  <span>CDK output · <code>{item.name}</code></span>
                  <span>Environment variable · <code>{item.envName}</code></span>
                </span>
              ))}
              {row.member?.typeText ? <span>Type · <code>{row.member.typeText}</code></span> : null}
            </InspectorResourceRow>
          );
        })}
      </ul>
    </InspectorDisclosure>
  );
}
