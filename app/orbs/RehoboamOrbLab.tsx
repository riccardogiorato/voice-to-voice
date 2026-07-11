"use client";

import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { VoiceOrbPhase } from "@/app/_components/voice/types";

const STUDY = {
  number: "01",
  name: "Riemann–Tukey cloud",
  detail: "Layered Together-magenta particles with windowed divergences and striped opacity.",
  source: "Mathematica study",
  href: "https://mathematica.stackexchange.com/questions/220008/what-is-westworlds-rehoboam-thinking-how-to-generate-its-graphical-interface",
} as const;

const VOICE_STATES = [
  { label: "Idle", duration: 1800 },
  { label: "Connecting", duration: 1600 },
  { label: "Listening", duration: 2800 },
  { label: "Thinking", duration: 2100 },
  { label: "Replying", duration: 3200 },
] as const;

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_variant;
uniform float u_motion;
uniform float u_phase;
uniform float u_activity;
uniform float u_thickness;
uniform float u_presence;
uniform vec3 u_lavender;
uniform vec3 u_magenta;
uniform vec3 u_orange;

#define PI 3.14159265359
#define TAU 6.28318530718

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 rotation = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    value += noise(p) * amplitude;
    p = rotation * p * 2.03 + 17.1;
    amplitude *= 0.5;
  }
  return value;
}

float state(float index) {
  return 1.0 - step(0.5, abs(u_variant - index));
}

float phaseDistance(float index) {
  float direct = abs(u_phase - index);
  return min(direct, min(abs(u_phase + 5.0 - index), abs(u_phase - 5.0 - index)));
}

float phaseState(float index) {
  return 1.0 - smoothstep(0.0, 1.0, phaseDistance(index));
}

float angleDistance(float a, float b) {
  return abs(atan(sin(a - b), cos(a - b)));
}

float windowAt(float angle, float center, float width) {
  float x = angleDistance(angle, center) / width;
  return exp(-x * x * 2.25);
}

float stroke(float distanceToLine, float core, float feather) {
  return 1.0 - smoothstep(core, core + feather, distanceToLine);
}

vec3 togetherGradient(float angle, float time) {
  float flow = fract(angle / TAU + 0.5 + time * 0.018);
  vec3 first = mix(u_lavender, u_magenta, smoothstep(0.02, 0.58, flow));
  return mix(first, u_orange, smoothstep(0.58, 0.96, flow));
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  float radius = length(uv);
  float angle = atan(uv.y, uv.x);
  float time = u_time * u_motion;

  float artstation = state(0.0);
  float reddit = state(1.0);
  float mathematica = state(2.0);
  float shadertoy = state(3.0);
  float titlecard = state(4.0);

  float idle = phaseState(0.0);
  float connecting = phaseState(1.0);
  float listening = phaseState(2.0);
  float thinking = phaseState(3.0);
  float replying = phaseState(4.0);

  float baseRadius = 0.56;
  float voiceWave =
    sin(angle * 5.0 - time * 3.4) * 0.48 +
    sin(angle * 9.0 + time * 2.6) * 0.3 +
    sin(angle * 15.0 - time * 4.2) * 0.16;
  baseRadius += voiceWave * replying * (0.014 + u_activity * 0.016);
  baseRadius += idle * sin(time * 0.52) * 0.0035;
  baseRadius += connecting * sin(time * 1.7) * 0.0025;
  baseRadius -= listening * (0.01 + sin(time * 1.15) * 0.004);
  float polarX = angle / TAU + 0.5;
  float low = fbm(vec2(polarX * 5.0 - time * 0.12, 2.0 + time * 0.065));
  float high = fbm(vec2(polarX * 29.0 + time * 0.08, 9.0 - time * 0.055));
  float pixelGrain = hash21(floor((uv + 1.0) * 420.0) + floor(time * 5.0));
  float angularGrain = hash21(vec2(floor(polarX * 720.0), floor(time * 7.0)));

  float eventA = windowAt(angle, -2.8 + time * 0.18, 0.16);
  float eventB = windowAt(angle, 0.58 - time * 0.11, 0.09);
  float eventC = windowAt(angle, 2.02 + time * 0.07, 0.055);

  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // 01 — ArtStation: luminous hairline with sparse, sharp displacement peaks.
  float artDisplacement = eventA * (0.08 + high * 0.07) + eventB * 0.035 + eventC * 0.024;
  float artDistance = abs(radius - (baseRadius + artDisplacement));
  float artLine = stroke(artDistance, 0.004, 0.008);
  float artGlow = exp(-artDistance * 45.0) * 0.32;
  float artRay = exp(-abs(angle + 2.8) * 42.0) * exp(-max(radius - baseRadius, 0.0) * 7.0);
  vec3 artColor = mix(vec3(1.0), u_lavender, 0.2);
  color += artColor * (artLine + artGlow * 0.65 + artRay * 0.35) * artstation;
  alpha += min(artLine + artGlow + artRay * 0.45, 1.0) * artstation;

  // 02 — Reddit analysis: a mathematically clean baseline with divergence
  // location, spread and severity encoded independently.
  float redditWindow = eventA + eventB * 0.7 + eventC * 0.5;
  float redditDisplacement = redditWindow * (0.018 + high * 0.055);
  float redditLine = stroke(abs(radius - (baseRadius + redditDisplacement)), 0.0035, 0.006);
  float redditSpike = pow(angularGrain, 9.0) * redditWindow * exp(-abs(radius - baseRadius) * 13.0);
  color += vec3(0.015) * (redditLine + redditSpike) * reddit;
  alpha += min(redditLine * 0.95 + redditSpike * 0.75, 0.98) * reddit;

  // 03 — Mathematica: twenty point layers sample a shared oscillation. Odd
  // and even layers rotate in opposite directions; Tukey-like windows gate
  // the large divergences and the particle opacity forms visible stripes.
  float cloud = 0.0;
  float cloudDivergence = 0.0;
  for (int i = 0; i < 20; i++) {
    float fi = float(i);
    float direction = mod(fi, 2.0) < 1.0 ? 1.0 : -1.0;
    float stateSpeed = idle * 0.025 + connecting * 0.12 + listening * 0.08 + thinking * 0.31 + replying * 0.16;
    float phase = polarX * (9.0 + mod(fi, 5.0)) + direction * time * stateSpeed;
    float wave = fbm(vec2(phase, fi * 1.73)) * 2.0 - 1.0;
    float layerRadius = baseRadius + wave * (0.008 + fi * 0.0018);
    float dotCell = hash21(vec2(floor(polarX * 1050.0), fi * 19.0));
    float stripe = 0.18 + 0.82 * pow(0.5 + 0.5 * cos(fi * 0.83 + time * 1.2), 10.0);
    float pointLayer = stroke(
      abs(radius - layerRadius),
      0.0015 * u_thickness,
      0.0035 * u_thickness
    ) * step(0.22, dotCell) * stripe;
    cloud += pointLayer;
    float tukey = eventA * smoothstep(0.0, 0.12, eventA) + eventB * 0.7;
    float divergentRadius = layerRadius + tukey * wave * (0.05 + fi * 0.0045);
    cloudDivergence += stroke(
      abs(radius - divergentRadius),
      0.0015 * u_thickness,
      0.0035 * u_thickness
    ) * step(0.3, dotCell) * tukey;
  }

  // Connecting assembles the perimeter from three bright orbiting arcs.
  float connectingArcs = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float arcCenter = -PI + fi * TAU / 3.0 + time * 0.72;
    float arcWindow = exp(-pow(angleDistance(angle, arcCenter) / 0.36, 2.0) * 2.0);
    float arcRadius = baseRadius + sin(time * 1.4 + fi * 2.1) * 0.006;
    connectingArcs += stroke(
      abs(radius - arcRadius),
      0.005 * u_thickness,
      0.009 * u_thickness
    ) * arcWindow;
  }

  // Thinking stays close to the shared silhouette. Two faint, partial inner
  // shimmers counter-rotate without turning the orb into a stack of rings.
  float thoughtRipples = 0.0;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float direction = mod(fi, 2.0) < 1.0 ? 1.0 : -1.0;
    float thoughtRadius = 0.43 + fi * 0.065 + sin(angle * (2.0 + fi) + time * direction * 1.25) * 0.007;
    float segment = pow(0.5 + 0.5 * sin(angle * (2.0 + fi) + time * direction * 0.9), 4.0);
    float shimmer = 0.2 + 0.8 * noise(vec2(polarX * 6.0 + time * direction * 0.16, fi * 5.3));
    thoughtRipples += stroke(
      abs(radius - thoughtRadius),
      0.0015 * u_thickness,
      0.01 * u_thickness
    ) * segment * shimmer;
  }

  float cloudInk = cloud * 0.72 + cloudDivergence * 0.86;
  float stateInk = connectingArcs * connecting * 1.3 + thoughtRipples * thinking * 0.3;
  color += u_magenta * (cloudInk + stateInk) * mathematica;
  alpha += min(cloud * 0.4 + cloudDivergence * 0.54 + stateInk * 0.7, 0.98) * mathematica;

  // 04 — Shadertoy description: polar data cells, counter-rotating scanning
  // rings, fracturing and RGB channel separation on a black field.
  float scan = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float rr = 0.22 + fi * 0.048;
    float direction = mod(fi, 2.0) < 1.0 ? 1.0 : -1.0;
    float segment = fract(polarX * (48.0 + fi * 7.0) + direction * time * 0.3);
    float gate = smoothstep(0.08, 0.18, segment) * (1.0 - smoothstep(0.72, 0.92, segment));
    float glitch = (hash21(vec2(floor(polarX * 96.0), fi)) - 0.5) * eventA * 0.06;
    scan += stroke(abs(radius - rr - glitch), 0.004, 0.007) * gate;
  }
  float channelR = stroke(abs(radius - baseRadius - 0.008 - (low - 0.5) * 0.025), 0.004, 0.008);
  float channelG = stroke(abs(radius - baseRadius - (high - 0.5) * 0.02), 0.004, 0.008);
  float channelB = stroke(abs(radius - baseRadius + 0.008 - (low - 0.5) * 0.025), 0.004, 0.008);
  vec3 splitColor = vec3(channelR, channelG, channelB);
  vec3 brand = togetherGradient(angle, time);
  color += (splitColor * 0.72 + brand * scan * 0.62) * shadertoy;
  alpha += min(max(max(channelR, channelG), channelB) * 0.9 + scan * 0.72, 0.96) * shadertoy;

  // 05 — title-card eclipse: dense black corona, fine particulate smoke and
  // a severe left-side event that bleeds toward and away from the white disc.
  float titleEvent = windowAt(angle, PI - 0.12 + sin(time * 0.45) * 0.35, 0.68);
  float titleRadius = baseRadius + (low - 0.5) * 0.018;
  float titleDistance = abs(radius - titleRadius);
  float titleCore = stroke(titleDistance, 0.014 + titleEvent * 0.045, 0.014);
  float smoke = exp(-titleDistance * (22.0 - titleEvent * 12.0));
  smoke *= smoothstep(0.38, 0.96, pixelGrain + high * 0.44);
  float outward = exp(-max(radius - titleRadius, 0.0) * 5.5) * titleEvent * pow(angularGrain, 3.0);
  float inward = exp(-max(titleRadius - radius, 0.0) * 5.0) * titleEvent * (0.28 + high * 0.72);
  float rays = pow(angularGrain, 12.0) * titleEvent * exp(-abs(radius - titleRadius) * 3.5);
  float titleInk = titleCore * (0.7 + high * 0.4) + smoke * 0.48 + outward * 0.72 + inward * 0.58 + rays * 0.5;
  color += vec3(0.008) * titleInk * titlecard;
  alpha += min(titleInk, 0.98) * titlecard;

  float phaseOpacity = idle * 0.7 + connecting * 0.85 + listening * 0.9 + thinking * 0.95 + replying;
  fragColor = vec4(color, min(alpha * phaseOpacity * u_presence, 0.98));
}`;

type GlContext = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: {
    time: WebGLUniformLocation | null;
    variant: WebGLUniformLocation | null;
    motion: WebGLUniformLocation | null;
    phase: WebGLUniformLocation | null;
    activity: WebGLUniformLocation | null;
    thickness: WebGLUniformLocation | null;
    presence: WebGLUniformLocation | null;
    lavender: WebGLUniformLocation | null;
    magenta: WebGLUniformLocation | null;
    orange: WebGLUniformLocation | null;
  };
};

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createContext(canvas: HTMLCanvasElement): GlContext | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    gl,
    program,
    uniforms: {
      time: gl.getUniformLocation(program, "u_time"),
      variant: gl.getUniformLocation(program, "u_variant"),
      motion: gl.getUniformLocation(program, "u_motion"),
      phase: gl.getUniformLocation(program, "u_phase"),
      activity: gl.getUniformLocation(program, "u_activity"),
      thickness: gl.getUniformLocation(program, "u_thickness"),
      presence: gl.getUniformLocation(program, "u_presence"),
      lavender: gl.getUniformLocation(program, "u_lavender"),
      magenta: gl.getUniformLocation(program, "u_magenta"),
      orange: gl.getUniformLocation(program, "u_orange"),
    },
  };
}

function RehoboamCanvas({
  variant,
  phase,
  playing,
  activity = 0.45,
  thickness = 1,
  presence = 1,
}: {
  variant: number;
  phase: number;
  playing: boolean;
  activity?: number;
  thickness?: number;
  presence?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<GlContext | null>(null);
  const frameRef = useRef(0);
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);
  const playingRef = useRef(playing);
  const phaseRef = useRef(phase);
  const displayedPhaseRef = useRef(phase);
  const lastFrameRef = useRef(0);
  const variantRef = useRef(variant);
  const activityRef = useRef(activity);
  const displayedActivityRef = useRef(activity);

  playingRef.current = playing;
  phaseRef.current = phase;
  variantRef.current = variant;
  activityRef.current = activity;

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const context = contextRef.current;
    if (!canvas || !context) return;

    const { gl, uniforms } = context;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width * dpr));
    const height = Math.max(1, Math.round(bounds.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const now = performance.now();
    const frameDelta = lastFrameRef.current
      ? Math.min((now - lastFrameRef.current) / 1000, 0.05)
      : 0;
    lastFrameRef.current = now;

    if (playingRef.current) {
      elapsedRef.current = (now - startedAtRef.current) / 1000;
    }

    let phaseDelta = phaseRef.current - displayedPhaseRef.current;
    if (phaseDelta > 2.5) phaseDelta -= 5;
    if (phaseDelta < -2.5) phaseDelta += 5;
    displayedPhaseRef.current += phaseDelta * (1 - Math.exp(-frameDelta * 4.4));
    if (displayedPhaseRef.current >= 5) displayedPhaseRef.current -= 5;
    if (displayedPhaseRef.current < 0) displayedPhaseRef.current += 5;
    displayedActivityRef.current +=
      (activityRef.current - displayedActivityRef.current) * (1 - Math.exp(-frameDelta * 7));

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(context.program);
    gl.uniform1f(uniforms.time, elapsedRef.current);
    const currentVariant = variantRef.current;
    gl.uniform1f(uniforms.variant, currentVariant);
    const motionSpeed = [2.15, 1.9, 2.45, 2.05, 1.9][currentVariant] ?? 1;
    gl.uniform1f(uniforms.motion, motionSpeed);
    gl.uniform1f(uniforms.phase, displayedPhaseRef.current);
    gl.uniform1f(uniforms.activity, displayedActivityRef.current);
    gl.uniform1f(uniforms.thickness, thickness);
    gl.uniform1f(uniforms.presence, presence);
    gl.uniform3f(uniforms.lavender, 0.78, 0.66, 0.96);
    gl.uniform3f(uniforms.magenta, 0.94, 0.17, 0.76);
    gl.uniform3f(uniforms.orange, 0.99, 0.3, 0.01);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    frameRef.current = window.requestAnimationFrame(render);
  }, [presence, thickness]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    contextRef.current = createContext(canvas);
    if (!contextRef.current) return;
    startedAtRef.current = performance.now() - elapsedRef.current * 1000;
    lastFrameRef.current = performance.now();
    frameRef.current = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frameRef.current);
      contextRef.current?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      contextRef.current = null;
    };
  }, [render]);

  useEffect(() => {
    if (playing) {
      startedAtRef.current = performance.now() - elapsedRef.current * 1000;
    }
  }, [playing]);

  return <canvas ref={canvasRef} className="block size-full" aria-hidden />;
}

const PRODUCTION_PHASE: Record<VoiceOrbPhase, number> = {
  idle: 0,
  connecting: 1,
  listening: 2,
  thinking: 3,
  speaking: 4,
};

export function RiemannTukeyVoiceOrb({
  phase,
  activity,
}: {
  phase: VoiceOrbPhase;
  activity: number;
}) {
  const normalizedActivity = Math.min(Math.max(activity, 0), 1);

  return (
    <div
      className="voice-shader-orb"
      data-state={phase}
      style={{ "--voice-activity": normalizedActivity } as CSSProperties}
      aria-hidden
    >
      <RehoboamCanvas
        variant={2}
        phase={PRODUCTION_PHASE[phase]}
        activity={normalizedActivity}
        thickness={3}
        presence={1.25}
        playing
      />
    </div>
  );
}

export function RehoboamOrbLab() {
  const [playing, setPlaying] = useState(true);
  const [voiceState, setVoiceState] = useState(0);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      setVoiceState((current) => (current + 1) % VOICE_STATES.length);
    }, VOICE_STATES[voiceState].duration);
    return () => window.clearTimeout(timer);
  }, [playing, voiceState]);

  return (
    <main className="min-h-dvh bg-[#f2f0eb] px-5 py-6 text-[#111013] sm:px-8 lg:px-10 lg:py-9">
      <div className="mx-auto max-w-[1440px]">
        <header className="mb-7 flex flex-col gap-5 border-b border-black/10 pb-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#765488]">
              Together voice · WebGL studies
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">
              Prediction circles
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-black/55 text-pretty">
              One layered polar study exploring listening, thought, and speech through a
              field of Together-colored particles.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="flex min-h-10 items-center gap-2 rounded-full bg-[#171419] px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_rgba(23,20,25,0.16)] transition-transform duration-150 active:scale-[0.96]"
              type="button"
              onClick={() => setPlaying((value) => !value)}
            >
              {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
              {playing ? "Pause motion" : "Resume motion"}
            </button>
            <a
              className="flex min-h-10 items-center rounded-full bg-white/80 px-4 py-2 text-sm font-medium text-black/62 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] transition-[color,scale] duration-150 hover:text-black active:scale-[0.96]"
              href="/"
            >
              Back to voice demo
            </a>
          </div>
        </header>

        <article className="overflow-hidden rounded-[30px] bg-[#fbfaf7] shadow-[0_0_0_1px_rgba(18,12,22,0.06),0_22px_60px_rgba(65,42,78,0.1)]">
          <div className="relative grid min-h-[440px] place-items-center overflow-hidden bg-[#fafaf7] sm:min-h-[620px]">
            <div className="absolute aspect-square w-[min(82%,680px)]">
              <RehoboamCanvas variant={2} phase={voiceState} playing={playing} />
            </div>

            <div className="absolute bottom-5 left-1/2 flex max-w-[calc(100%_-_24px)] -translate-x-1/2 gap-1.5 overflow-x-auto rounded-full bg-black/70 p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.18)] backdrop-blur-md">
              {VOICE_STATES.map((state, index) => (
                <button
                  className={`min-h-10 shrink-0 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${
                    voiceState === index ? "bg-white text-black" : "text-white/55 hover:text-white"
                  }`}
                  type="button"
                  onClick={() => setVoiceState(index)}
                  aria-pressed={voiceState === index}
                  key={state.label}
                >
                  {state.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-start gap-4 border-t border-black/[0.055] px-6 py-5">
            <span className="font-mono text-xs tabular-nums text-[#8b7696]">{STUDY.number}</span>
            <div>
              <h2 className="text-base font-semibold tracking-[-0.01em]">{STUDY.name}</h2>
              <p className="mt-1 text-sm leading-6 text-black/48 text-pretty">{STUDY.detail}</p>
              <a
                className="mt-2 inline-flex text-xs font-medium text-[#765488] underline decoration-[#765488]/25 underline-offset-4 hover:decoration-[#765488]/70"
                href={STUDY.href}
                target="_blank"
                rel="noreferrer"
              >
                Source: {STUDY.source}
              </a>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}
