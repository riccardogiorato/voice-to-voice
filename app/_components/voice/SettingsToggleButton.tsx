import { SlidersHorizontal, X } from "lucide-react";
import { cx } from "./utils";

export function SettingsToggleButton({
  open = false,
  onClick,
}: {
  open?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className="grid size-10 place-items-center rounded-full bg-white text-[#050505]/70 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)] transition-[box-shadow,scale] duration-150 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_3px_12px_rgba(5,5,5,0.08)] active:scale-[0.96]"
      type="button"
      aria-expanded={open}
      aria-label={open ? "Close settings" : "Open settings"}
      title={open ? "Close settings" : "Settings"}
      onClick={onClick}
    >
      <span className="relative grid size-4 place-items-center">
        <SlidersHorizontal
          className={cx(
            "absolute size-4 transition-[opacity,filter,scale] duration-200",
            open ? "scale-[0.25] opacity-0 blur-xs" : "scale-100 opacity-100 blur-0",
          )}
          aria-hidden
        />
        <X
          className={cx(
            "absolute size-4 transition-[opacity,filter,scale] duration-200",
            open ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-xs",
          )}
          aria-hidden
        />
      </span>
    </button>
  );
}
