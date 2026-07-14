import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Together Realtime v2",
  description: "OpenAI Realtime-compatible voice agents on Together AI",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
