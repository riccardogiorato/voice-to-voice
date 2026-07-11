export function VoiceStatusPill({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-full bg-white/38 px-4 py-2 text-center shadow-[0_0_0_1px_rgba(255,255,255,0.55),0_10px_28px_rgba(90,43,103,0.08)] backdrop-blur-xl">
      <p className="text-[13px] font-medium leading-4 text-[#58496c]">{label}</p>
      <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#897b98]">
        {detail}
      </p>
    </div>
  );
}
