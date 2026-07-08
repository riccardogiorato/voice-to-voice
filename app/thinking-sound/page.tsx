import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ThinkingSoundControl } from "@/app/_components/ThinkingSoundControl";

export default function ThinkingSoundPage() {
  return (
    <main className="min-h-dvh bg-[#faf9f6] px-5 py-6 text-[#050505]">
      <div className="mx-auto flex min-h-[calc(100dvh-48px)] w-full max-w-3xl flex-col">
        <header className="flex items-center justify-between gap-4">
          <Link
            className="grid size-10 place-items-center rounded-full bg-white text-[#050505]/72 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)] transition-[scale,box-shadow] duration-150 active:scale-[0.96]"
            href="/"
            aria-label="Back to voice"
            title="Back"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
          <p className="text-sm font-semibold text-[#050505]/58">Together Voice</p>
        </header>

        <section className="flex flex-1 flex-col items-center justify-center gap-8 py-10">
          <div className="max-w-xl text-center">
            <p className="font-display text-4xl font-semibold tracking-normal text-[#050505] sm:text-5xl">
              Thinking sound
            </p>
          </div>

          <ThinkingSoundControl variant="full" />
        </section>
      </div>
    </main>
  );
}
