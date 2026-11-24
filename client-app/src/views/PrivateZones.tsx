import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { PrivateDnsRecord, TargetReference } from "aws-studio/config";
import { privateRecordName } from "aws-studio/config/private-dns";
import { privateZoneSettings, type PrivateZoneSettings } from "../../shared/private-dns";
import { useStudio } from "../studio";
import { sourceEditBlocked } from "../editing-state";
import { buttonClasses } from "../ui/Button";
import { Select, TextInput } from "../ui/FormControls";
import { InspectorSection, InspectorSwitch } from "./InspectorUI";
import { DocumentCard, documentCardTitleClasses, documentSupportClasses, documentLabelClasses, documentFieldsetClasses, documentProseClasses } from "./DocumentUI";

/** VPC association edits use exactly the same zone transaction as Domains. */
export function VpcPrivateZones({ networkId }: { readonly networkId: string }) {
  const { model, snapshot, draft, draftState, live } = useStudio();
  const zones = model.privateHostedZones ?? [];
  const associated = zones.filter(zone => zone.vpcIds.includes(networkId));
  const available = zones.filter(zone => !zone.vpcIds.includes(networkId));
  const [selected, setSelected] = useState("");
  const disabled = sourceEditBlocked({ draftState, draft, model, live }) || Object.values(snapshot.models).some(model => model.status === "error");
  return <InspectorSection title="Private hosted zones" description="Private DNS visibility is configured independently from network access.">
    {associated.length ? <ul className="m-0 pl-4 text-label">{associated.map(zone => <li key={zone.id} className="mb-2">
      <Link className={buttonClasses({ variant: "link" })} to="/domains" search={{ zone: zone.id }}>{zone.name}</Link>
      <span className="ml-2 text-caption text-graphite">{zone.enabled ? "Configured" : "Disabled"} · local DNS unavailable</span>
    </li>)}</ul> : <p className="my-0 text-label text-graphite">No private hosted zones associated.</p>}
    <Link className={buttonClasses({ variant: "quiet", className: "mt-3" })} to="/domains" search={{ vpc: networkId, newZone: true }}>Create private hosted zone</Link>
    {available.length ? <div className="mt-3 grid gap-2">
      <label className="grid gap-1 text-label">Existing declared zone
        <Select aria-label="Existing private zone" value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)}>
          <option value="">Select a private zone</option>
          {available.map(zone => <option key={zone.id} value={zone.id}>{zone.name} ({zone.id})</option>)}
        </Select>
      </label>
      <button className={buttonClasses({ variant: "quiet" })} disabled={disabled || !available.some(zone => zone.id === selected)} onClick={() => {
        const zone = available.find(zone => zone.id === selected)!;
        const pending = draft.privateZone(zone.id);
        if (pending?.operation === "remove") return;
        const settings = pending?.settings ?? privateZoneSettings(zone);
        draft.setPrivateZone({ kind: "privateZone", operation: "update", id: zone.id, settings: { ...settings, vpcIds: [...new Set([...settings.vpcIds, networkId])] } });
      }}>Associate private zone</button>
    </div> : null}
    {draftState.entries.some(entry => entry.kind === "privateZone") ? <p className="mb-0 text-caption" role="status">Private DNS changes are pending source review.</p> : null}
    <Link className={buttonClasses({ variant: "link", className: "mt-3" })} to="/domains" search={{ vpc: networkId }}>Manage private zones in Domains</Link>
  </InspectorSection>;
}

/** Form values live in InspectorDraft, with normal review, navigation protection,
 * conflict recovery and apply. No browser-local DNS registry is maintained. */
export function PrivateZonesWorkspace() {
  const studio = useStudio();
  const { model, snapshot, draft, draftState, live } = studio;
  const search = useSearch({ strict: false }) as { readonly zone?: string; readonly vpc?: string; readonly newZone?: boolean };
  const zones = model.privateHostedZones ?? [];
  const networks = model.networks ?? [];
  const endpoints = model.privateDnsEndpoints ?? [];
  const [selectedId, setSelectedId] = useState(search.zone ?? "");
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("internal");
  const nameInput = useRef<HTMLInputElement>(null);
  const addRecord = useRef<HTMLButtonElement>(null);
  const recordInputs = useRef(new Map<string, HTMLInputElement>());
  const focusRecord = useRef<string | undefined>(undefined);
  const disabled = sourceEditBlocked({ draftState, draft, model, live }) || Object.values(snapshot.models).some(model => model.status === "error");
  const id = creating ? newId : selectedId;
  const saved = zones.find(zone => zone.id === id);
  const pending = draft.privateZone(id);
  const settings = pending && pending.operation !== "remove" ? pending.settings : saved ? privateZoneSettings(saved) : undefined;
  const error = draftState.entries.find(entry => entry.kind === "privateZone" && entry.edit.id === id)?.error;
  const set = (next: PrivateZoneSettings) => draft.setPrivateZone({ kind: "privateZone", operation: creating ? "create" : "update", id, settings: next });
  const create = () => {
    if (disabled || draft.dirty || !networks.length) return;
    let candidate = "internal";
    for (let n = 2; zones.some(zone => zone.id === candidate); n++) candidate = `internal-${n}`;
    setNewId(candidate); setCreating(true); setSelectedId("");
    draft.setPrivateZone({ kind: "privateZone", operation: "create", id: candidate, settings: { name: "", enabled: true, vpcIds: [networks.find(network => network.id === search.vpc)?.id ?? networks[0]!.id], records: [] } });
    queueMicrotask(() => nameInput.current?.focus());
  };
  const routeRequest = useRef("");
  useEffect(() => {
    const request = JSON.stringify(search);
    if (routeRequest.current === request) return;
    if (search.newZone && !networks.length) return;
    routeRequest.current = request;
    if (search.zone) { setSelectedId(search.zone); setCreating(false); }
    else if (search.newZone && networks.length) create();
  }, [search.zone, search.vpc, search.newZone, networks.length]);
  useEffect(() => { if (creating) nameInput.current?.focus(); }, [creating]);
  useEffect(() => {
    if (!focusRecord.current) return;
    (recordInputs.current.get(focusRecord.current) ?? addRecord.current)?.focus();
    focusRecord.current = undefined;
  }, [settings?.records]);
  useEffect(() => {
    if (creating && !pending) {
      if (saved) setSelectedId(saved.id);
      setCreating(false);
    }
  }, [creating, pending, saved, draft.resetVersion]);
  const updateRecord = (recordId: string, patch: Partial<PrivateDnsRecord>) => settings && set({ ...settings, records: settings.records.map(record => record.id === recordId ? { ...record, ...patch } : record) });
  return <DocumentCard aria-label="Private hosted zones" data-slot="private-zones">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className={documentCardTitleClasses}>Private hosted zones</h2>
      <button className={buttonClasses({ variant: "quiet" })} disabled={disabled || draft.dirty || !networks.length} onClick={create}>Create private hosted zone</button>
    </div>
    <p className={documentProseClasses}>Configure Route 53 namespaces and records for declared VPCs. Saving reviews TypeScript source; AWS deployment is separate.</p>
    <p className={documentSupportClasses} role="status">Local private DNS execution is unavailable. AWS behavior is unverified until cloud integration tests pass. These controls do not activate a local resolver.</p>
    {!networks.length ? <p className={documentSupportClasses}>Declare a VPC on the map before creating a private zone.</p> : null}
    {!zones.length && !creating ? <p className={documentSupportClasses}>No private hosted zones declared.</p> : null}
    {zones.length ? <div className="flex flex-wrap gap-2" aria-label="Declared private zones">{zones.map(zone => <button key={zone.id} className={buttonClasses({ variant: "quiet" })} aria-pressed={zone.id === selectedId && !creating} disabled={disabled || draft.dirty && zone.id !== id} onClick={() => { setCreating(false); setSelectedId(zone.id); }}>
      {zone.name} · {zone.enabled ? `${zone.vpcIds.length} VPC${zone.vpcIds.length === 1 ? "" : "s"}` : "disabled"}
    </button>)}</div> : null}
    {selectedId && !saved && !creating ? <p role="alert" className="text-label text-refuse">The selected private zone is not declared in this source environment.</p> : null}
    {settings ? <fieldset disabled={disabled} className="m-0 mt-4 min-w-0 border-0 p-0">
      <legend className="px-0 text-label font-semibold">{creating ? "New private hosted zone" : `Configure ${saved?.name ?? id}`}</legend>
      <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
        <label className={documentLabelClasses}>Zone identity
          <TextInput aria-label="Private zone identity" value={id} readOnly={!creating} onChange={event => {
            const value = event.target.value;
            draft.discardPrivateZone(id); setNewId(value);
            draft.setPrivateZone({ kind: "privateZone", operation: "create", id: value, settings });
          }} />
        </label>
        <label className={documentLabelClasses}>DNS name
          <TextInput ref={nameInput} aria-label="Private zone DNS name" autoComplete="off" spellCheck={false} placeholder="internal.example.test" value={settings.name} onChange={event => set({ ...settings, name: event.target.value })} />
        </label>
      </div>
      <p className={documentSupportClasses}>A valid unregistered DNS name is allowed. Zone identity and deployed construct identity remain stable when the DNS name changes.</p>
      <label className="my-3 flex items-center gap-2 text-label">Include zone in AWS deployment <InspectorSwitch label="Include private zone in AWS deployment" checked={settings.enabled} onChange={enabled => set({ ...settings, enabled })} /></label>
      <fieldset className={documentFieldsetClasses}>
        <legend className="px-1 text-label">VPC associations</legend>
        <div className="grid gap-2">{networks.map(network => <label key={network.id} className="flex items-start gap-2 text-label">
          <input type="checkbox" aria-label={`Associate private zone with VPC ${network.id}`} checked={settings.vpcIds.includes(network.id)} onChange={event => set({ ...settings, vpcIds: event.target.checked ? [...settings.vpcIds, network.id] : settings.vpcIds.filter(id => id !== network.id) })} />
          <span>{network.name ?? network.id} · {network.cidr}{network.gatewayEndpoints.length || network.interfaceEndpoints.length ? <span className="mt-1 block text-caption text-graphite">Existing VPC endpoints are preserved. Their local DNS/network behavior has not been qualified.</span> : null}</span>
        </label>)}</div>
        <p className={documentSupportClasses}>Associate at least one VPC. Sharing DNS adds no peering, routes or endpoint permissions.</p>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-label font-semibold">A alias records</h3>
        <button ref={addRecord} className={buttonClasses({ variant: "quiet" })} disabled={!endpoints.length || settings.records.length >= 100} onClick={() => {
          let recordId = "record-1";
          for (let n = 2; settings.records.some(record => record.id === recordId); n++) recordId = `record-${n}`;
          focusRecord.current = recordId;
          set({ ...settings, records: [...settings.records, { id: recordId, name: "", type: "A", target: { kind: "ecs-internal-alb", service: endpoints[0]!.service }, enabled: false, allowFrom: [] }] });
          queueMicrotask(() => recordInputs.current.get(recordId)?.focus());
        }}>Add alias record</button>
      </div>
      {!endpoints.length ? <p className={documentSupportClasses}>No ECS internal ALB endpoint capabilities are declared. Other target types are not supported yet.</p> : null}
      {!settings.records.length ? <p className={documentSupportClasses}>This zone has no application records. Its namespace will still be authoritative in associated VPCs when deployed.</p> : null}
      {settings.records.map((record, n) => {
        const endpoint = endpoints.find(endpoint => endpoint.service === record.target.service);
        const callers = model.targets.filter(target => ["lambda", "service", "task"].includes(target.kind) && target.placement.kind === "vpc" && target.placement.networkId === endpoint?.vpcId);
        let hostname = "Enter a valid zone and record name";
        try { hostname = `http://${privateRecordName(settings.name.toLowerCase().replace(/\.$/, ""), record.name)}/`; } catch { /* Retain incomplete form input. */ }
        return <fieldset key={record.id} className={documentFieldsetClasses}>
          <legend className="px-1 text-label">Record {n + 1} · {record.id}</legend>
          <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
            <label className={documentLabelClasses}>Name (relative, or @ for the apex)
              <TextInput ref={node => { if (node) recordInputs.current.set(record.id, node); else recordInputs.current.delete(record.id); }} aria-label={`Record ${n + 1} name`} value={record.name} placeholder="api" onChange={event => updateRecord(record.id, { name: event.target.value })} />
            </label>
            <label className={documentLabelClasses}>Resource endpoint
              <Select aria-label={`Record ${n + 1} endpoint`} value={record.target.service} onChange={event => updateRecord(record.id, { target: { kind: "ecs-internal-alb", service: event.target.value }, allowFrom: [], enabled: false })}>
                {!endpoint ? <option value={record.target.service}>{record.target.service} · unavailable</option> : null}
                {endpoints.map(endpoint => <option key={endpoint.service} value={endpoint.service}>{endpoint.title} · internal ALB{endpoint.productionEnabled ? "" : " · not deployed by production"}</option>)}
              </Select>
            </label>
          </div>
          <p className="my-2 break-all text-label font-mono">{hostname}</p>
          <p className={documentSupportClasses}>AWS target: the service's internal ALB · HTTP port 80 · TTL inherited from the ALB. Local target: unavailable.</p>
          <label className="my-3 flex items-center gap-2 text-label">Include record in AWS deployment <InspectorSwitch label={`Include record ${n + 1} in AWS deployment`} checked={record.enabled !== false} disabled={!endpoint?.productionEnabled} onChange={enabled => updateRecord(record.id, { enabled })} /></label>
          {!endpoint?.productionEnabled ? <p className={documentSupportClasses}>Enable this service's production deployment before enabling its DNS record. The disabled record can be saved now.</p> : null}
          <fieldset className={documentFieldsetClasses} disabled={!!endpoint?.gatewayAuth}>
            <legend className="px-1 text-label">Explicit connectivity grants</legend>
            <p className={documentSupportClasses}>{endpoint?.gatewayAuth ? "This service uses API Gateway authentication. Direct ALB grants are unavailable because they would bypass its authorizer." : "Admit selected same-VPC workloads to this service's HTTP/80 listener. These grants also allow other hostnames and direct ALB addresses; DNS visibility alone grants nothing."}</p>
            <div className="mt-2 grid gap-2">{callers.map(caller => <label key={caller.ref} className="flex items-start gap-2 text-label">
              <input type="checkbox" aria-label={`Record ${n + 1} allow ${caller.ref}`} checked={record.allowFrom?.includes(caller.ref as TargetReference) ?? false} onChange={event => updateRecord(record.id, { allowFrom: event.target.checked ? [...(record.allowFrom ?? []), caller.ref as TargetReference] : record.allowFrom?.filter(ref => ref !== caller.ref) })} />
              <span>{caller.title} <span className="text-caption text-graphite">{caller.ref}</span></span>
            </label>)}</div>
          </fieldset>
          <button className={buttonClasses({ variant: "quiet", tone: "danger" })} onClick={() => {
            const remaining = settings.records.filter(item => item.id !== record.id);
            focusRecord.current = remaining[Math.min(n, remaining.length - 1)]?.id ?? "add";
            set({ ...settings, records: remaining });
            queueMicrotask(() => (recordInputs.current.get(remaining[Math.min(n, remaining.length - 1)]?.id ?? "") ?? addRecord.current)?.focus());
          }}>Remove record {n + 1}</button>
        </fieldset>;
      })}
      {error ? <p className="text-label text-refuse" role="alert">{error}</p> : null}
      {saved?.deploymentProblems.length ? <div className="my-3 text-label text-refuse" role="status">{saved.deploymentProblems.map(problem => <p key={problem}>{problem}</p>)}</div> : null}
      <p className={documentSupportClasses}>Review Changes saves declarations only. Deployment, DNS resolution, TCP reachability and application authentication have separate validation.</p>
      {saved && pending?.operation !== "remove" ? <button className={buttonClasses({ variant: "quiet", tone: "danger", className: "mt-3" })} disabled={draft.dirty} onClick={() => draft.setPrivateZone({ kind: "privateZone", operation: "remove", id: saved.id })}>Remove private zone from application</button> : null}
      {pending?.operation === "remove" ? <p role="status" className="text-label">Zone removal is staged. Review its source diff before applying; AWS deletion requires a separate deployment.</p> : null}
    </fieldset> : null}
  </DocumentCard>;
}
