export function VoiceStatusPill({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-full bg-white/38 px-4 py-2 text-center shadow-[0_0_0_1px_rgba(255,255,255,0.55),0_10px_28px_rgba(90,43,103,0.08)] backdrop-blur-xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b5a82]">
        {label} - {detail}
      </p>
    </div>
  );
}
