import type { CSSProperties } from "react";
import { cx } from "./utils";

export function VoiceWaveform({
  active = false,
  activity,
}: {
  active?: boolean;
  activity: number | string;
}) {
  const style = {
    "--voice-activity": typeof activity === "number" ? activity.toFixed(3) : activity,
  } as CSSProperties;

  return (
    <div
      className={cx("voice-waveform", active && "voice-waveform-active")}
      style={style}
      aria-hidden
    >
      {[0.34, 0.62, 0.46, 0.82, 0.54, 1, 0.5, 0.78, 0.42, 0.66, 0.36].map(
        (gain, index) => (
          <span key={index} style={{ "--bar-gain": gain } as CSSProperties} />
        ),
      )}
    </div>
  );
}

export function VoiceMicMeter({
  active = false,
  level,
}: {
  active?: boolean;
  level: number | string;
}) {
  const style = {
    "--mic-level": typeof level === "number" ? level.toFixed(3) : level,
  } as CSSProperties;

  return (
    <div
      className={cx("voice-mic-meter", active && "voice-mic-meter-active")}
      style={style}
      aria-hidden
    >
      {[0.32, 0.58, 0.42, 0.76, 0.52, 0.94, 0.64, 1, 0.46, 0.7, 0.36].map(
        (gain, index) => (
          <span key={index} style={{ "--meter-gain": gain } as CSSProperties} />
        ),
      )}
    </div>
  );
}
