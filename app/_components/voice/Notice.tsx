import { Clock3, TriangleAlert } from "lucide-react";
import { cx } from "./utils";

export function VoiceNotice({ message }: { message: string }) {
  const normalizedMessage = message.toLowerCase();
  const isLimitNotice = normalizedMessage.includes("time limit");
  const isDisconnectNotice = normalizedMessage.includes("connection lost");
  const Icon = isLimitNotice ? Clock3 : TriangleAlert;
  const title = isLimitNotice
    ? "Call time reached"
    : isDisconnectNotice
      ? "Call disconnected"
      : "Something went wrong";
  const detail = isLimitNotice ? "Start a new call when you're ready." : message;

  return (
    <div className="rounded-[22px] bg-white/64 px-3.5 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.62),0_10px_28px_rgba(65,42,78,0.09)] backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <span
          className={cx(
            "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full",
            isLimitNotice ? "bg-[#f6e9ff] text-[#7f4fac]" : "bg-[#fff1ec] text-[#c54718]",
          )}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-5 text-[#1f1824]">{title}</p>
          <p className="mt-0.5 text-pretty text-sm leading-5 text-[#574b60]">
            {detail}
          </p>
        </div>
      </div>
    </div>
  );
}
