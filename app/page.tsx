"use client";

import { VoicePhone } from "@/app/_components/VoicePhone";
import { useVoiceConversation } from "@/app/_hooks/useVoiceConversation";

export default function Home() {
  const voice = useVoiceConversation();

  return <VoicePhone voice={voice} />;
}
