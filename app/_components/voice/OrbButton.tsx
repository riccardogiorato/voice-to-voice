import type { CSSProperties } from "react";
import type { VoiceOrbPhase } from "./types";

export function VoiceOrbButton({
  phase,
  activity,
  disabled = false,
  onClick,
}: {
  phase: VoiceOrbPhase;
  activity: number | string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const style = {
    "--voice-activity": typeof activity === "number" ? activity.toFixed(3) : activity,
  } as CSSProperties;

  return (
    <button
      className="voice-orb-button"
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Start conversation"
      title={disabled ? undefined : "Start conversation"}
    >
      <div className={`voice-orb voice-orb-${phase}`} style={style} aria-hidden>
        <div className="voice-orb-core" />
      </div>
    </button>
  );
}
