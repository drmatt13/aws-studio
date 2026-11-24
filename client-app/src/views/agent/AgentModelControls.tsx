import type { AgentLabProvider } from "../../agent-lab-api";
import { Select } from "../../ui/FormControls";

interface AgentModelOption { readonly id: string; readonly label: string; readonly description?: string }

export function AgentModelControls({ id, provider, onProviderChange, model, onModelChange, models, modelUnavailable, loading, available, disabled }: {
  readonly id: string;
  readonly provider: AgentLabProvider;
  readonly onProviderChange: (provider: AgentLabProvider) => void;
  readonly model: string;
  readonly onModelChange: (model: string) => void;
  readonly models?: readonly AgentModelOption[];
  readonly modelUnavailable: boolean;
  readonly loading: boolean;
  readonly available: boolean;
  readonly disabled: boolean;
}) {
  const selectedModel = models?.find(item => item.id === model);
  return <>
    <label className="sr-only" htmlFor={`${id}-provider`}>Agent provider</label>
    <Select id={`${id}-provider`} appearance="quiet" controlSize="compact" className="max-w-full text-caption" value={provider} disabled={disabled}
      onChange={event => onProviderChange(event.target.value as AgentLabProvider)}><option value="codex">Codex</option><option value="claude">Claude</option></Select>
    <label className="sr-only" htmlFor={`${id}-model`}>Agent model</label>
    <Select id={`${id}-model`} appearance="quiet" controlSize="compact" className="max-w-45 text-caption" value={model} disabled={disabled || !available}
      title={selectedModel?.description ?? "Choose a model"} onChange={event => onModelChange(event.target.value)}>
      <option value="">CLI default</option>
      {model && !selectedModel ? <option value={model}>{model}{modelUnavailable ? " (unavailable)" : ""}</option> : null}
      {models?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      {loading ? <option disabled>Loading models…</option> : null}
    </Select>
  </>;
}
