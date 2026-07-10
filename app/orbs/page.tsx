import type { Metadata } from "next";
import { RehoboamOrbLab } from "./RehoboamOrbLab";

export const metadata: Metadata = {
  title: "Rehoboam Orb Studies",
  description: "Five WebGL studies for the Together voice orb.",
};

export default function OrbsPage() {
  return <RehoboamOrbLab />;
}
