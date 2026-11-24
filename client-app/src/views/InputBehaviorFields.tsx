import { useId } from "react";
import type { Mode } from "../../shared/model";
import type { ResourceModeForm } from "../draft";
import { environmentCardClasses } from "../inspector-ui";
import { environmentCheckboxClasses, Select, TextInput } from "../ui/FormControls";
import { EnvironmentName } from "./InspectorUI";

const MODES = ["dev", "prod"] as const;
const MODE_NAMES = { dev: "development", prod: "production" } as const;
const modeOptionClasses =
  "flex min-h-(--panel-caption-target) min-w-0 cursor-pointer items-center gap-2 text-ink has-disabled:cursor-not-allowed has-disabled:text-graphite";

export function InputBehaviorFields({
  modes, linked, choices, showDefault, descriptionId, availability, onChange,
}: {
  readonly modes: Readonly<Record<Mode, ResourceModeForm>>;
  readonly linked: boolean;
  readonly choices: readonly string[];
  readonly showDefault: boolean;
  readonly descriptionId: string;
  readonly availability?: readonly Mode[];
  readonly onChange: (mode: Mode, change: Partial<ResourceModeForm>) => void;
}) {
  const id = useId();
  return (
    <div
      className="grid grid-cols-2 gap-2 inspector-360:grid-cols-1"
      data-slot="input-modes"
    >
      {MODES.map((mode) => {
        const present = modes[mode].present;
        const label = `${linked ? "Default" : "Value"} in ${MODE_NAMES[mode]}`;
        const value = present
          ? linked
            ? modes[mode].default
            : (modes[mode].value ?? "")
          : "";
        const change = (value: string) =>
          onChange(mode, linked ? { default: value } : { value });
        return (
          <div
            key={mode}
            role="group"
            aria-labelledby={`${id}-${mode}`}
            aria-describedby={descriptionId}
            className={environmentCardClasses({ mode, active: present })}
            data-slot="input-mode"
            data-mode={mode}
          >
            <EnvironmentName id={`${id}-${mode}`} mode={mode} active={present} />
            <label className={modeOptionClasses}>
              <input
                type="checkbox"
                aria-label={`Available in ${MODE_NAMES[mode]}`}
                checked={present}
                disabled={availability !== undefined && !availability.includes(mode)}
                onChange={(event) => onChange(mode, { present: event.target.checked })}
                className={environmentCheckboxClasses[mode]}
              />
              Available
            </label>
            {linked ? (
              <label className={modeOptionClasses}>
                <input
                  type="checkbox"
                  aria-label={`Required in ${MODE_NAMES[mode]}`}
                  disabled={!present}
                  checked={present && modes[mode].required}
                  onChange={(event) => onChange(mode, { required: event.target.checked })}
                  className={environmentCheckboxClasses[mode]}
                />
                Required
              </label>
            ) : null}
            {showDefault ? (
              <label className="mt-1 grid min-w-0 gap-1 text-graphite">
                {linked ? "Default" : "Value"}
                {choices.length ? (
                  <Select
                    controlSize="panel"
                    className="w-full text-ink"
                    aria-label={label}
                    disabled={!present}
                    value={value}
                    onChange={(event) => change(event.target.value)}
                  >
                    <option value="" disabled={!linked}>
                      {linked ? "None" : "Choose a value"}
                    </option>
                    {choices.map((value, index) => (
                      <option key={index}>{value}</option>
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    controlSize="panel"
                    className="w-full text-ink"
                    aria-label={label}
                    disabled={!present}
                    value={value}
                    placeholder={linked ? "None" : "Enter a value"}
                    onChange={(event) => change(event.target.value)}
                  />
                )}
              </label>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
