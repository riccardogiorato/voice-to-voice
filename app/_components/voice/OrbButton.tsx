import type { VoiceOrbPhase } from "./types";
import { VoiceShaderOrb } from "./VoiceShaderOrb";

export function VoiceOrbButton({
  phase,
  activity,
  disabled = false,
  onClick,
}: {
  phase: VoiceOrbPhase;
  activity: number;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className="voice-orb-button"
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Start conversation"
      title={disabled ? undefined : "Start conversation"}
    >
      <VoiceShaderOrb phase={phase} activity={activity} />
    </button>
  );
}
