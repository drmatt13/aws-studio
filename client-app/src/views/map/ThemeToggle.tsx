import { Moon, Sun } from "lucide-react";
import { toggleStudioTheme, useStudioTheme } from "../../theme";
import { cx } from "../../ui/classes";
import { mapFloatingButtonClasses } from "../map-styles";

export function ThemeToggle({ motion }: { motion: boolean }) {
  const dark = useStudioTheme() === "dark";
  const label = `Switch to ${dark ? "light" : "dark"} mode`;
  const iconClasses = cx(
    "absolute",
    motion && "transition-[opacity,translate,rotate,scale] duration-500 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
  );
  return (
    <button
      type="button"
      className={cx(mapFloatingButtonClasses, "pointer-events-auto relative shrink-0 overflow-hidden")}
      aria-label={label}
      title={label}
      onClick={toggleStudioTheme}
    >
      <Sun
        size={20}
        strokeWidth={1.75}
        aria-hidden
        className={cx(iconClasses, "text-local", dark ? "translate-y-3 rotate-90 scale-50 opacity-0" : "translate-y-0 rotate-0 scale-100 opacity-100")}
      />
      <Moon
        size={20}
        strokeWidth={1.75}
        aria-hidden
        className={cx(iconClasses, "text-sky-200", dark ? "translate-y-0 rotate-0 scale-100 opacity-100" : "-translate-y-3 -rotate-90 scale-50 opacity-0")}
      />
    </button>
  );
}
