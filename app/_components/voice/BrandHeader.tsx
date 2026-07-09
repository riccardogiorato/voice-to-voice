import Image from "next/image";
import { SettingsToggleButton } from "./SettingsToggleButton";

export function VoiceBrandHeader({
  settingsOpen = false,
  onSettingsClick,
}: {
  settingsOpen?: boolean;
  onSettingsClick?: () => void;
}) {
  return (
    <header className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2.5">
        <Image
          className="h-6 w-[110px] object-contain object-left"
          src="/together-logo.svg"
          alt="Together AI"
          width={110}
          height={24}
          priority
        />
        <span className="h-4 w-px bg-[#050505]/14" aria-hidden />
        <span className="text-sm font-semibold tracking-tight text-[#050505]/78">
          Voice
        </span>
      </div>
      <SettingsToggleButton open={settingsOpen} onClick={onSettingsClick} />
    </header>
  );
}
