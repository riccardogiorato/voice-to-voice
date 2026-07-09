import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.LYRIA_MODEL || "lyria-3-clip-preview";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const OUT_DIR = join(process.cwd(), "public", "thinking-sounds");

type Candidate = {
  id: string;
  name: string;
  prompt: string;
};

const candidates: Candidate[] = [
  {
    id: "01-soft-orbit",
    name: "Soft Orbit",
    prompt:
      "Create a seamless 30-second instrumental ambient loop for an AI voice assistant thinking state. Soft warm synth pad, subtle low pulse, no drums, no vocals, calm and unobtrusive, designed to loop cleanly.",
  },
  {
    id: "02-glass-thought",
    name: "Glass Thought",
    prompt:
      "Create a seamless 30-second instrumental loop for an AI thinking indicator. Delicate glassy tones, very light shimmer, quiet bass bed, no melody hook, no vocals, no percussion, clean loop ending.",
  },
  {
    id: "03-low-console",
    name: "Low Console",
    prompt:
      "Create a seamless 30-second instrumental ambient loop like a quiet futuristic console processing. Low analog hum, soft rounded pulses, restrained, no vocals, no lyrics, no drums, loopable.",
  },
  {
    id: "04-warm-current",
    name: "Warm Current",
    prompt:
      "Create a seamless 30-second instrumental loop for a voice AI waiting/thinking sound. Warm current of synths, gentle movement, soft low-pass texture, reassuring, no vocals, no drums, no sharp melody.",
  },
  {
    id: "05-digital-breath",
    name: "Digital Breath",
    prompt:
      "Create a seamless 30-second instrumental loop. Quiet digital breath, airy texture, slow soft modulation, minimal and intimate, no vocals, no lyrics, no percussion, made for background while an AI thinks.",
  },
  {
    id: "06-deep-focus",
    name: "Deep Focus",
    prompt:
      "Create a seamless 30-second instrumental ambient loop for deep focus. Sub-bass pad, soft harmonic overtones, slow gentle pulse, no vocals, no drums, subtle enough to sit under speech.",
  },
  {
    id: "07-crystal-wait",
    name: "Crystal Wait",
    prompt:
      "Create a seamless 30-second instrumental loop for an AI assistant thinking. Sparse crystalline plucks, soft pad tail, very calm, no vocals, no beat, no strong melody, loop-friendly start and end.",
  },
  {
    id: "08-quiet-engine",
    name: "Quiet Engine",
    prompt:
      "Create a seamless 30-second instrumental loop like a quiet friendly engine idling. Soft low motor tone, faint synth movement, no vocals, no percussion, no dramatic build, useful as an AI thinking sound.",
  },
  {
    id: "09-ambient-loader",
    name: "Ambient Loader",
    prompt:
      "Create a seamless 30-second instrumental ambient loading loop. Smooth electronic pad, gentle repeating signal, relaxed tempo, no vocals, no lyrics, no drums, polished UI sound design.",
  },
  {
    id: "10-soft-signal",
    name: "Soft Signal",
    prompt:
      "Create a seamless 30-second instrumental loop for an AI voice interface. Soft signal tones, warm synth ambience, small evolving texture, no vocals, no drums, no busy melody, clean looping feel.",
  },
];

if (!API_KEY) {
  throw new Error("Missing GEMINI_API_KEY.");
}
const GEMINI_API_KEY = API_KEY;

const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const selected = only
  ? candidates.filter((candidate) => candidate.id === only)
  : candidates;

if (selected.length === 0) {
  throw new Error(`No thinking sound candidate matched --only=${only}`);
}

mkdirSync(OUT_DIR, { recursive: true });

const manifest = [];
for (const candidate of selected) {
  console.log(`Generating ${candidate.id} ${candidate.name}...`);
  const audio = await generateClip(candidate.prompt);
  const src = `/thinking-sounds/${candidate.id}.mp3`;
  writeFileSync(join(OUT_DIR, `${candidate.id}.mp3`), audio);
  manifest.push({
    id: candidate.id,
    name: candidate.name,
    src,
    prompt: candidate.prompt,
  });
}

const manifestPath = join(OUT_DIR, "manifest.json");
const previousManifest = only ? await readExistingManifest(manifestPath) : [];
const mergedManifest = only
  ? [
      ...previousManifest.filter((item) => !selected.some((candidate) => candidate.id === item.id)),
      ...manifest,
    ].sort((a, b) => a.id.localeCompare(b.id))
  : manifest;

writeFileSync(manifestPath, JSON.stringify(mergedManifest, null, 2) + "\n");
console.log(`Generated ${selected.length} Lyria clip(s) in ${OUT_DIR}`);

async function generateClip(prompt: string) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: `${prompt} Instrumental only, no vocals.` }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Lyria request failed with ${response.status}: ${body.slice(0, 800)}`);
  }

  const json: any = await response.json();
  for (const candidate of json.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inlineData = part.inlineData ?? part.inline_data;
      if (inlineData?.data) return Buffer.from(inlineData.data, "base64");
    }
  }

  throw new Error("Lyria response did not include inline audio data.");
}

async function readExistingManifest(path: string) {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8")) as Array<{
      id: string;
      name: string;
      src: string;
      prompt?: string;
    }>;
  } catch {
    return [];
  }
}
