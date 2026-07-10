"use client";

import { memo, useCallback, useEffect, useRef, type CSSProperties } from "react";
import type { VoiceOrbPhase } from "./types";

type ShaderOrbState = "idle" | "connecting" | "listening" | "speaking" | "muted";

const SHADER_STATE_INDEX: Record<ShaderOrbState, number> = {
  idle: 0,
  connecting: 1,
  listening: 2,
  speaking: 3,
  muted: 4,
};

const TOGETHER_COLORS: [number, number, number][] = [
  [0.78, 0.66, 0.96],
  [0.94, 0.17, 0.76],
  [0.99, 0.3, 0.01],
];

type OrbParams = {
  speed: number;
  amplitude: number;
  glow: number;
  brightness: number;
  pulse: number;
  saturation: number;
};

const STATE_PARAMS: Record<ShaderOrbState, OrbParams> = {
  idle: {
    speed: 0.14,
    amplitude: 0.035,
    glow: 0.2,
    brightness: 0.98,
    pulse: 0,
    saturation: 0.2,
  },
  connecting: {
    speed: 0.34,
    amplitude: 0.075,
    glow: 0.38,
    brightness: 0.75,
    pulse: 1,
    saturation: 0.46,
  },
  listening: {
    // Listening is a stable state. The speaking animation is the signal that
    // the assistant is actively talking, so don't make mic noise move the orb.
    speed: 0,
    amplitude: 0.045,
    glow: 0.44,
    brightness: 0.85,
    pulse: 0,
    saturation: 0.84,
  },
  speaking: {
    speed: 0.96,
    amplitude: 0.34,
    glow: 0.8,
    brightness: 1,
    pulse: 0,
    saturation: 1,
  },
  muted: {
    speed: 0.06,
    amplitude: 0.015,
    glow: 0.08,
    brightness: 0.35,
    pulse: 0,
    saturation: 0.2,
  },
};

const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_speed;
uniform float u_amplitude;
uniform float u_glow;
uniform float u_brightness;
uniform float u_pulse;
uniform float u_saturation;
uniform float u_state;
uniform vec3 u_color0;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform float u_dpr;

vec3 mod289(vec3 x) { return x - floor(x / 289.0) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x / 289.0) * 289.0; }
vec4 permute(vec4 x) { return mod289((x * 34.0 + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  vec3 i = floor(v + dot(v, vec3(C.y)));
  vec3 x0 = v - i + dot(i, vec3(C.x));
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g, l.zxy);
  vec3 i2 = max(g, l.zxy);
  vec3 x1 = x0 - i1 + C.x;
  vec3 x2 = x0 - i2 + C.y;
  vec3 x3 = x0 - 0.5;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec4 j = p - 49.0 * floor(p / 49.0);
  vec4 x_ = floor(j / 7.0);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = (x_ * 2.0 + 0.5) / 7.0 - 1.0;
  vec4 y = (y_ * 2.0 + 0.5) / 7.0 - 1.0;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 g0 = vec3(a0.xy, h.x);
  vec3 g1 = vec3(a0.zw, h.y);
  vec3 g2 = vec3(a1.xy, h.z);
  vec3 g3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g0,g0), dot(g1,g1), dot(g2,g2), dot(g3,g3)));
  g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(g0,x0), dot(g1,x1), dot(g2,x2), dot(g3,x3)));
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  float dist = length(uv);
  float angle = atan(uv.y, uv.x);
  float t = u_time * u_speed;

  float isIdle = 1.0 - step(0.5, abs(u_state - 0.0));
  float isConnecting = 1.0 - step(0.5, abs(u_state - 1.0));
  float isListening = 1.0 - step(0.5, abs(u_state - 2.0));
  float isSpeaking = 1.0 - step(0.5, abs(u_state - 3.0));
  float isMuted = 1.0 - step(0.5, abs(u_state - 4.0));

  float radius = 0.62;
  // Treat the orb as a liquid contour rather than a filled gradient sphere.
  // The broad wave makes the ring drift like ink; the finer wave breaks up
  // its edge into the soft, imperfect silhouette of a fluid drawing.
  float broadWave = snoise(vec3(uv * 2.8 + 4.0, t * 0.55));
  float fineWave = snoise(vec3(uv * 8.0 - 8.0, t * 0.35));
  // Keep the silhouette unmistakably circular; the liquid character should
  // live in the edge density and small ripples, not in a melted outline.
  float waveAmount = 0.012 + u_amplitude * 0.08;
  float liquidWave = broadWave * waveAmount + fineWave * waveAmount * 0.22;
  float colorPresence = smoothstep(0.12, 0.95, u_saturation);
  float pulse = u_pulse * sin(u_time * 3.5) * 0.012;
  float liquidRadius = radius + liquidWave + pulse;
  float ringDistance = abs(dist - liquidRadius);
  // Each phase has a distinct weight: listening is a confident single mark,
  // while speaking becomes the heaviest, most energetic contour.
  float ringWidth =
    isIdle * 0.025 +
    isConnecting * 0.032 +
    isListening * 0.046 +
    isSpeaking * 0.07 +
    isMuted * 0.024;
  float ringCore = 1.0 - smoothstep(0.008, ringWidth, ringDistance);
  float ringMist = exp(-ringDistance * 38.0);

  // Connecting/thinking borrows the concentric scanning rings from the
  // reference sequence. Listening and speaking remain single-circle states.
  float ripple1 = 1.0 - smoothstep(0.006, 0.018, abs(dist - (radius - 0.105 + pulse * 1.8)));
  float ripple2 = 1.0 - smoothstep(0.006, 0.017, abs(dist - (radius - 0.205 + pulse * 1.2)));
  float ripple3 = 1.0 - smoothstep(0.006, 0.016, abs(dist - (radius - 0.295 + pulse * 0.7)));
  float rippleInk = (ripple1 * 0.7 + ripple2 * 0.5 + ripple3 * 0.32) * isConnecting;

  // Uneven density keeps the contour from reading as a perfect vector ring.
  float inkGrain = snoise(vec3(uv * 13.0 + 2.0, t * 0.28)) * 0.5 + 0.5;
  float inkDensity = 0.58 + inkGrain * 0.42;

  // Speaking carries a dense patch of ink around the ring, like the advancing
  // dark mass in the reference, but it remains recognizably circular.
  float tendrilNoise = snoise(vec3(uv * 5.0 - 13.0, t * 0.22)) * 0.5 + 0.5;
  float sweep = snoise(vec3(cos(angle) * 1.4, sin(angle) * 1.4, t * 0.42)) * 0.5 + 0.5;
  float speechMass = smoothstep(0.48, 0.82, sweep) * isSpeaking;
  float tendrils = smoothstep(0.62, 0.9, tendrilNoise) * u_amplitude * 0.28 * isSpeaking;
  float outerInk = exp(-max(dist - liquidRadius, 0.0) * 28.0) * tendrils;

  float colorFlow = sin(angle + t * 0.4) * 0.5 + 0.5;
  vec3 togetherColor = mix(u_color0, u_color1, 0.25 + colorFlow * 0.68);
  togetherColor = mix(togetherColor, u_color2, smoothstep(0.58, 0.96, colorFlow) * 0.72);
  vec3 inkColor = mix(vec3(0.025, 0.02, 0.04), togetherColor, colorPresence * 0.86);
  vec3 color = inkColor * (0.76 + ringCore * 0.34) * u_brightness;
  color += mix(u_color1, vec3(1.0), 0.35) * ringMist * u_amplitude * 0.2;
  color += togetherColor * (rippleInk * 0.34 + speechMass * ringMist * 0.28);

  float innerHaze = (1.0 - smoothstep(0.0, radius, dist)) * (0.018 + u_glow * 0.025);
  float ringOpacity =
    isIdle * 0.3 +
    isConnecting * 0.58 +
    isListening * 0.86 +
    isSpeaking * 1.0 +
    isMuted * 0.22;
  float alpha = max(
    ringCore * inkDensity * ringOpacity,
    ringMist * (0.06 + speechMass * 0.2) + outerInk * 0.3
  );
  alpha = max(alpha, rippleInk * (0.2 + inkDensity * 0.28));
  alpha += innerHaze;

  fragColor = vec4(color, min(alpha, 0.94));
}`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initWebGL(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
  });
  if (!gl) return null;

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    gl,
    uniforms: {
      u_time: gl.getUniformLocation(program, "u_time"),
      u_speed: gl.getUniformLocation(program, "u_speed"),
      u_amplitude: gl.getUniformLocation(program, "u_amplitude"),
      u_glow: gl.getUniformLocation(program, "u_glow"),
      u_brightness: gl.getUniformLocation(program, "u_brightness"),
      u_pulse: gl.getUniformLocation(program, "u_pulse"),
      u_saturation: gl.getUniformLocation(program, "u_saturation"),
      u_state: gl.getUniformLocation(program, "u_state"),
      u_color0: gl.getUniformLocation(program, "u_color0"),
      u_color1: gl.getUniformLocation(program, "u_color1"),
      u_color2: gl.getUniformLocation(program, "u_color2"),
      u_dpr: gl.getUniformLocation(program, "u_dpr"),
    },
  };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mapPhaseToShaderState(phase: VoiceOrbPhase): ShaderOrbState {
  return phase === "thinking" ? "connecting" : phase;
}

export const VoiceShaderOrb = memo(function VoiceShaderOrb({
  phase,
  activity,
}: {
  phase: VoiceOrbPhase;
  activity: number;
}) {
  const state = mapPhaseToShaderState(phase);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<ReturnType<typeof initWebGL>>(null);
  const frameRef = useRef(0);
  const startedAtRef = useRef(0);
  const activityRef = useRef(0);
  const currentActivityRef = useRef(0);
  const stateRef = useRef(state);
  const currentParams = useRef({ ...STATE_PARAMS.idle });
  const targetParams = useRef({ ...STATE_PARAMS.idle });

  activityRef.current = activity;
  stateRef.current = state;

  useEffect(() => {
    targetParams.current = { ...STATE_PARAMS[state] };
  }, [state]);

  const render = useCallback(() => {
    const context = glRef.current;
    const canvas = canvasRef.current;
    if (!context || !canvas) return;

    const { gl, uniforms } = context;
    const current = currentParams.current;
    const target = targetParams.current;
    const smooth = 0.018;

    current.speed = lerp(current.speed, target.speed, smooth);
    current.amplitude = lerp(current.amplitude, target.amplitude, smooth);
    current.glow = lerp(current.glow, target.glow, smooth);
    current.brightness = lerp(current.brightness, target.brightness, smooth);
    current.pulse = lerp(current.pulse, target.pulse, smooth);
    current.saturation = lerp(current.saturation, target.saturation, smooth);
    currentActivityRef.current = lerp(currentActivityRef.current, activityRef.current, 0.04);

    const dpr = window.devicePixelRatio || 1;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.round(bounds.width * dpr);
    const height = Math.round(bounds.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const elapsed = (performance.now() - startedAtRef.current) / 1000;
    // Activity is meaningful for the assistant's audio only. Keeping it out
    // of the listening state prevents the orb from flickering as the user
    // talks, which makes the speaking state much easier to recognize.
    const currentState = stateRef.current;
    const volume = currentState === "speaking" ? currentActivityRef.current : 0;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uniforms.u_time, elapsed);
    gl.uniform1f(uniforms.u_speed, current.speed + volume * 0.24);
    gl.uniform1f(uniforms.u_amplitude, current.amplitude + volume * 0.075);
    gl.uniform1f(uniforms.u_glow, current.glow + volume * 0.14);
    gl.uniform1f(uniforms.u_brightness, current.brightness);
    gl.uniform1f(uniforms.u_pulse, current.pulse);
    gl.uniform1f(uniforms.u_saturation, current.saturation);
    gl.uniform1f(uniforms.u_state, SHADER_STATE_INDEX[currentState]);
    gl.uniform3fv(uniforms.u_color0, TOGETHER_COLORS[0]);
    gl.uniform3fv(uniforms.u_color1, TOGETHER_COLORS[1]);
    gl.uniform3fv(uniforms.u_color2, TOGETHER_COLORS[2]);
    gl.uniform1f(uniforms.u_dpr, dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    frameRef.current = window.requestAnimationFrame(render);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    startedAtRef.current = performance.now();
    glRef.current = initWebGL(canvas);
    if (!glRef.current) return;

    frameRef.current = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frameRef.current);
      const context = glRef.current;
      context?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      glRef.current = null;
    };
  }, [render]);

  const normalizedActivity = Math.min(Math.max(activity, 0), 1);

  return (
    <canvas
      ref={canvasRef}
      className="voice-shader-orb"
      data-state={state}
      style={{ "--voice-activity": normalizedActivity } as CSSProperties}
      aria-hidden
    />
  );
});
