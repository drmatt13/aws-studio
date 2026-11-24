import { useState } from "react";
import { FileCode2 } from "lucide-react";
import type { GraphQLSchemaInventory } from "../../../shared/graphql-workspace";
import { TextInput } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";
import { documentDataTableClasses, documentProseClasses, documentSupportClasses, documentTableRegionClasses, documentTitleClasses } from "../DocumentUI";
import {
  WorkbenchListHeading, WorkbenchPageHeader, workbenchCardClasses, workbenchCompactChoiceClasses, workbenchEmptyClasses,
  workbenchMasterDetailClasses, workbenchPageClasses, workbenchPanelClasses,
  workbenchSegmentClasses, workbenchSegmentGroupClasses,
} from "../WorkbenchUI";
import { CatalogChoice, catalogListClasses } from "./GraphQLCatalog";
import { graphqlPreClasses, graphqlTableCodeCellClasses, graphqlTableHeadClasses } from "./GraphQLChainDetails";

export function GraphQLSchema({ schema }: { readonly schema: GraphQLSchemaInventory }) {
  const [search, setSearch] = useState(""), [selected, setSelected] = useState("Query"), [display, setDisplay] = useState<"fields" | "sdl">("fields");
  const filter = search.trim().toLowerCase();
  const types = schema.types.filter(type => !filter || type.name.toLowerCase().includes(filter) || type.fields.some(field => field.name.toLowerCase().includes(filter)));
  const type = schema.types.find(item => item.name === selected) ?? types[0];
  return <section aria-labelledby="graphql-schema-title" className={workbenchPageClasses}>
    <WorkbenchPageHeader icon={FileCode2} titleId="graphql-schema-title" title="Schema" description={<>Generated schema · <code className="font-mono">{schema.file}</code></>} />
    {schema.diagnostics.map((item, index) => <Notice key={index} role="alert">{item.message}</Notice>)}
    {schema.status !== "available" ? <p className={workbenchEmptyClasses}>{schema.status === "missing" ? "No generated schema is available." : "The generated schema could not be read."} Run <code>npm run codegen</code>, then check again.</p> : <div className={workbenchMasterDetailClasses}>
      <section aria-label="GraphQL types" className={workbenchPanelClasses("grid content-start gap-2")}>
        <WorkbenchListHeading count={types.length}>Types</WorkbenchListHeading>
        <TextInput id="graphql-type-search" type="search" aria-label="Find a type or field" placeholder="Find a type or field" value={search} onChange={event => setSearch(event.target.value)} />
        {types.length ? <div className={catalogListClasses}>{types.map(item => <button key={item.name} type="button" aria-label={`${item.name} ${item.kind}`} aria-pressed={type?.name === item.name} className={workbenchCompactChoiceClasses} onClick={() => setSelected(item.name)}>
          <CatalogChoice name={item.name} kind={item.kind} />
        </button>)}</div> : <p className="m-0 px-3 text-caption text-graphite">No types match “{search}”.</p>}
      </section>
      {type ? <section aria-labelledby="graphql-selected-type" className={workbenchCardClasses}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1"><p className={documentSupportClasses}>{type.kind} type</p><h3 id="graphql-selected-type" className={documentTitleClasses}>{type.name}</h3></div>
          <div role="group" aria-label="Show type as" className={workbenchSegmentGroupClasses}>{(["fields", "sdl"] as const).map(mode => <button key={mode} type="button" className={workbenchSegmentClasses("text")} aria-pressed={display === mode} onClick={() => setDisplay(mode)}>{mode === "fields" ? "Fields" : "SDL"}</button>)}</div>
        </div>
        {type.description ? <p className={documentProseClasses}>{type.description}</p> : null}
        {display === "sdl" ? <pre tabIndex={0} aria-label={`${type.name} SDL`} className={graphqlPreClasses}>{type.definition}</pre>
          : type.fields.length ? <div role="region" aria-label={`${type.name} fields`} tabIndex={0} className={documentTableRegionClasses}><table className={documentDataTableClasses}>
            <thead><tr>{["Field", "GraphQL type", "Arguments / default"].map(label => <th key={label} scope="col" className={graphqlTableHeadClasses}>{label}</th>)}</tr></thead>
            <tbody>{type.fields.map(field => <tr key={field.name}>
              <th scope="row" className={graphqlTableCodeCellClasses}>{field.name}{field.deprecationReason ? <span className="block font-sans text-caution">Deprecated · {field.deprecationReason}</span> : null}</th>
              <td className={graphqlTableCodeCellClasses}>{field.type}</td>
              <td className={graphqlTableCodeCellClasses}>{field.args.length ? field.args.map(arg => `${arg.name}: ${arg.type}${arg.defaultValue !== null ? ` = ${arg.defaultValue}` : ""}`).join(", ") : field.defaultValue ?? <span className="font-sans text-graphite">—</span>}</td>
            </tr>)}</tbody>
          </table></div>
          : type.enumValues.length ? <ul className="m-0 grid gap-2 pl-5 font-mono text-caption">{type.enumValues.map(value => <li key={value.name}>{value.name}{value.deprecationReason ? <span className="font-sans text-caution"> · Deprecated: {value.deprecationReason}</span> : null}</li>)}</ul>
          : type.members.length ? <p className="m-0 font-mono text-label">{type.members.join(" | ")}</p>
          : <p className={documentSupportClasses}>Scalar type · no fields.</p>}
        {type.interfaces.length ? <p className={documentSupportClasses}>Implements {type.interfaces.join(", ")}</p> : null}
      </section> : null}
    </div>}
  </section>;
}
