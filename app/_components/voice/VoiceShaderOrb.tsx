"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import type { VoiceOrbPhase } from "./types";

type ShaderOrbState = "idle" | "connecting" | "listening" | "speaking" | "muted";

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
    saturation: 0.78,
  },
  connecting: {
    speed: 0.34,
    amplitude: 0.075,
    glow: 0.38,
    brightness: 0.75,
    pulse: 1,
    saturation: 0.9,
  },
  listening: {
    speed: 0.28,
    amplitude: 0.095,
    glow: 0.44,
    brightness: 0.85,
    pulse: 0,
    saturation: 1,
  },
  speaking: {
    speed: 0.82,
    amplitude: 0.24,
    glow: 0.72,
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
  float t = u_time * u_speed;

  float radius = 0.62;
  float circle = 1.0 - smoothstep(radius - 0.014, radius + 0.002, dist);

  if (circle < 0.001) {
    float glowDist = dist - radius;
    float glow = exp(-glowDist * 18.0) * u_glow * 0.08;
    vec3 glowColor = mix(u_color0, u_color1, 0.5);
    fragColor = vec4(glowColor * glow, glow);
    return;
  }

  float n1 = snoise(vec3(uv * 2.0, t * 0.6)) * 0.5 + 0.5;
  float n2 = snoise(vec3(uv * 3.5 + 7.0, t * 0.9)) * 0.5 + 0.5;
  float n3 = snoise(vec3(uv * 1.5 - 3.0, t * 0.4 + 10.0)) * 0.5 + 0.5;

  vec2 distort = vec2(
    snoise(vec3(uv * 2.0 + 5.0, t * 0.7)),
    snoise(vec3(uv * 2.0 + 15.0, t * 0.7))
  ) * u_amplitude * 2.0;
  float n4 = snoise(vec3((uv + distort) * 3.0, t * 0.5)) * 0.5 + 0.5;

  vec3 col = mix(u_color0, u_color1, n1);
  col = mix(col, u_color2, n2 * 0.5);
  col = mix(col, u_color1 * 1.3, n4 * 0.4);

  float vein = pow(n3, 3.0) * u_amplitude * 6.0;
  col += vein * mix(u_color1, vec3(1.0), 0.3);

  float centerDist = dist / radius;
  float depthShade = 1.0 - centerDist * centerDist * 0.24;
  col *= depthShade;

  float rim = pow(centerDist, 4.0) * 0.18;
  col += rim * u_color0;

  vec2 lightPos = vec2(-0.15, -0.18);
  float specDist = length(uv - lightPos);
  float spec = exp(-specDist * specDist * 30.0) * 0.48;
  col += spec * vec3(1.0);

  vec2 lightPos2 = vec2(0.2, 0.25);
  float spec2 = exp(-length(uv - lightPos2) * 8.0) * 0.15;
  col += spec2 * u_color1;

  float pulseFactor = 1.0 + u_pulse * sin(u_time * 3.5) * 0.35;

  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, u_saturation);

  col *= u_brightness * pulseFactor;

  fragColor = vec4(col, circle);
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
  const currentParams = useRef({ ...STATE_PARAMS.idle });
  const targetParams = useRef({ ...STATE_PARAMS.idle });

  activityRef.current = activity;

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
    const volume = currentActivityRef.current;

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

  return <canvas ref={canvasRef} className="voice-shader-orb" data-state={state} aria-hidden />;
});
