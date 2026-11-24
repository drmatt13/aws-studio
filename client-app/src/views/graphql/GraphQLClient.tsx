import { useState } from "react";
import { AppWindow, Compass, ExternalLink } from "lucide-react";
import type { GraphQLClientInventory, GraphQLDocument } from "../../../shared/graphql-workspace";
import type { ChainStatus } from "../../graphql-chain";
import { editorLink } from "../../lookup";
import { Button, buttonClasses } from "../../ui/Button";
import { TextInput } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";
import { documentSubheadingClasses, documentSupportClasses, documentTitleClasses, documentCardTitleClasses } from "../DocumentUI";
import {
  WorkbenchListHeading, WorkbenchPageHeader, workbenchCardClasses, workbenchCompactChoiceClasses, workbenchEmptyClasses,
  workbenchMasterDetailClasses, workbenchPageClasses, workbenchPanelClasses,
} from "../WorkbenchUI";
import { ChainStatusLabel } from "./ChainStatusIcon";
import { CatalogChoice, catalogListClasses } from "./GraphQLCatalog";
import { graphqlPreClasses } from "./GraphQLChainDetails";

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

function generatedStatus(document: GraphQLDocument): ChainStatus {
  if (document.generated.status === "available") return { label: `Available · ${document.generated.exportName ?? "generated export"}`, shape: "passed", tone: "accept" };
  return document.generated.status === "missing" ? { label: "Not generated", shape: "pending", tone: "caution" } : { label: "Unknown", shape: "unknown", tone: "quiet" };
}

export function GraphQLClient({ client, repositoryRoot, onExplore }: { readonly client: GraphQLClientInventory; readonly repositoryRoot: string; readonly onExplore: (document: GraphQLDocument) => void }) {
  const [search, setSearch] = useState(""), [selected, setSelected] = useState<string>();
  const filter = search.trim().toLowerCase(), documents = client.documents.filter(item => `${item.name} ${item.kind} ${item.file}`.toLowerCase().includes(filter));
  const document = client.documents.find(item => item.id === selected) ?? documents[0];
  const feature = client.features.find(item => item.file === document?.file);
  const options = feature?.exports.filter(item => document && item.documents.includes(document.id)) ?? [];
  const factories = feature?.exports.filter(item => item.kind === "key-factory") ?? [];
  const operations = client.documents.filter(item => item.kind !== "fragment").length, fragments = client.documents.length - operations;
  return <section aria-labelledby="graphql-client-title" className={workbenchPageClasses}>
    <WorkbenchPageHeader icon={AppWindow} titleId="graphql-client-title" title="Client" description="Authored documents, fragments and TanStack Query options." />
    {client.diagnostics.map((item, index) => <Notice key={index} role="alert">{item.message}</Notice>)}
    {!client.documents.length ? <p className={workbenchEmptyClasses}>No authored GraphQL documents were found in <code>client-app/src/api</code>.</p> : <div className={workbenchMasterDetailClasses}>
      <section aria-label="Client documents" className={workbenchPanelClasses("grid content-start gap-2")}>
        <WorkbenchListHeading count={documents.length}>Documents</WorkbenchListHeading>
        <TextInput id="graphql-operation-search" type="search" aria-label="Find an operation or fragment" placeholder="Find an operation or fragment" value={search} onChange={event => setSearch(event.target.value)} />
        {documents.length ? <div className={catalogListClasses}>{documents.map(item => <button key={item.id} type="button" aria-label={`${item.name} ${item.kind}`} aria-pressed={document?.id === item.id} className={workbenchCompactChoiceClasses} onClick={() => setSelected(item.id)}>
          <CatalogChoice name={item.name} kind={item.kind} />
        </button>)}</div> : <p className="m-0 px-3 text-caption text-graphite">No documents match “{search}”.</p>}
        <p className="m-0 px-3 text-caption text-graphite">{count(operations, "operation", "operations")} · {count(fragments, "fragment", "fragments")}</p>
      </section>
      {document ? <div className="grid min-w-0 gap-4">
        <section aria-labelledby="graphql-client-document" className={workbenchCardClasses}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <p className={documentSupportClasses}>{document.kind}</p>
              <h3 id="graphql-client-document" className={documentTitleClasses}>{document.name}</h3>
              <p className="m-0 font-mono text-caption text-graphite wrap-anywhere">{document.file}:{document.line}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!document.executableSource || document.kind === "fragment" || document.kind === "subscription"} onClick={() => onExplore(document)}><Compass size={14} aria-hidden />Run in Explorer</Button>
              <a className={buttonClasses({ variant: "quiet" })} href={editorLink(repositoryRoot, { file: document.file, line: document.line, column: 1 })}><ExternalLink size={14} aria-hidden />Open source</a>
            </div>
          </div>
          {document.diagnostics.map((item, index) => <Notice key={index} role="alert">{item.message}</Notice>)}
          <div className="grid gap-2">
            <h4 className={documentSubheadingClasses}>Selected fields</h4>
            {document.selections.length ? <ul className="m-0 flex list-none flex-wrap gap-2 p-0">{document.selections.map(field => <li key={field} className="rounded-sm border border-rule bg-paper px-2 py-1 font-mono text-caption">{field}</li>)}</ul> : <p className={documentSupportClasses}>No field selections are available.</p>}
          </div>
          {document.fragmentNames.length ? <div className="grid gap-2">
            <h4 className={documentSubheadingClasses}>Fragments</h4>
            <div className="flex flex-wrap gap-x-4 gap-y-2">{document.fragmentNames.map(name => <Button key={name} type="button" variant="link" className="font-mono text-caption" onClick={() => { const fragment = client.documents.find(item => item.kind === "fragment" && item.name === name); if (fragment) setSelected(fragment.id); }}>{name}</Button>)}</div>
          </div> : null}
        </section>
        <section aria-labelledby="graphql-client-authored" className={workbenchCardClasses}>
          <h3 id="graphql-client-authored" className={documentCardTitleClasses}>Authored document</h3>
          <pre tabIndex={0} aria-label="Authored GraphQL document" className={graphqlPreClasses}>{document.source}</pre>
        </section>
        <section aria-labelledby="graphql-client-options" className={workbenchCardClasses}>
          <h3 id="graphql-client-options" className={documentCardTitleClasses}>Query and mutation options</h3>
          {options.length ? options.map(option => <div key={option.name} className="grid gap-2">
            <h4 className={documentSubheadingClasses}>{option.name} <span className="font-normal text-graphite">· {option.kind}</span></h4>
            <pre tabIndex={0} aria-label={`${option.name} source`} className={graphqlPreClasses}>{option.expression}</pre>
          </div>) : <p className={documentSupportClasses}>No direct options reference was found for this document.</p>}
          {factories.map(factory => <div key={factory.name} className="grid gap-2">
            <h4 className={documentSubheadingClasses}>Key factory <span className="font-normal text-graphite">· {factory.name}</span></h4>
            <pre tabIndex={0} aria-label={`${factory.name} source`} className={graphqlPreClasses}>{factory.expression}</pre>
          </div>)}
          <p className={documentSupportClasses}>Key factories are shown as authored source; dynamic cache keys are not evaluated.</p>
        </section>
        <section aria-labelledby="graphql-client-generated" className={workbenchCardClasses}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <h3 id="graphql-client-generated" className={documentCardTitleClasses}>Generated document</h3>
            <ChainStatusLabel status={generatedStatus(document)} className="text-caption font-medium" />
          </div>
          {document.generated.hash ? <p className="m-0 break-all font-mono text-caption text-graphite">{document.generated.hash}</p> : null}
          {document.generated.source ? <pre tabIndex={0} aria-label="Generated GraphQL document" className={graphqlPreClasses}>{document.generated.source}</pre> : null}
        </section>
      </div> : null}
    </div>}
  </section>;
}
