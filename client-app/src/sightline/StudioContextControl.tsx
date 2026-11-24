import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { Mode } from "../../shared/model";
import { Button } from "../ui/Button";
import { TextInput } from "../ui/FormControls";
import { WorkbenchDialog } from "../views/WorkbenchUI";

export function StudioContextControl({
  value,
  includeContext,
  onIncludeContextChange,
  description,
  details,
  previewLabel = "Studio context preview",
  disabled,
}: {
  readonly value: { readonly focus?: { readonly name?: string } | null; readonly source: { readonly mode: Mode } };
  readonly includeContext: boolean;
  readonly onIncludeContextChange: (value: boolean) => void;
  readonly description: string;
  readonly details?: string;
  readonly previewLabel?: string;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const Icon = includeContext ? Eye : EyeOff;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
        title={`Studio context · ${value.source.mode === "dev" ? "Development" : "Production"}${includeContext ? "" : " · excluded"}`}
        className="inline-flex min-h-7 min-w-0 max-w-40 shrink-[4] cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 py-0.5 text-caption text-graphite transition-[background-color,color] duration-120 hover:bg-wash hover:text-ink"
      >
        <Icon size={13} aria-hidden className="shrink-0" />
        <span className="min-w-0 truncate">
          <span className="sr-only">Context: </span>
          <span className={includeContext ? undefined : "line-through"}>{value.focus?.name ?? "Whole project"}</span>
          {includeContext ? "" : <span className="sr-only"> · excluded</span>}
        </span>
      </button>
      {open ? (
        <WorkbenchDialog
          title="Studio context"
          size="help"
          onClose={close}
          footer={<Button type="button" onClick={close}>Close</Button>}
        >
          <label className="flex items-center gap-2">
            <TextInput
              type="checkbox"
              checked={includeContext}
              disabled={disabled}
              onChange={(event) => onIncludeContextChange(event.target.checked)}
            />
            Include Studio context
          </label>
          <p className="m-0">{description}{details ? ` ${details}` : ""}</p>
          <pre
            aria-label={previewLabel}
            tabIndex={0}
            className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap text-meta wrap-anywhere"
          >
            {JSON.stringify(value, null, 2)}
          </pre>
        </WorkbenchDialog>
      ) : null}
    </>
  );
}
