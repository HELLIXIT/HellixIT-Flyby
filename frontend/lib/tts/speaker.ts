'use client';

/**
 * One `speak()` for the app, with two engines:
 *  - "device": the best voice the browser/OS offers (Edge "Natural", Google, Apple Premium/Enhanced…),
 *    ranked automatically, or one the user picked;
 *  - "kokoro": an open-source neural voice (Kokoro-82M) running locally in a Web Worker —
 *    no key, no server; ~90 MB downloaded once and cached.
 * If Kokoro can't load, it falls back to the device voice.
 */

export type VoiceEngine = 'device' | 'kokoro';

export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart — US female (warm)' },
  { id: 'af_bella', label: 'Bella — US female (bright)' },
  { id: 'am_michael', label: 'Michael — US male' },
  { id: 'am_puck', label: 'Puck — US male (lively)' },
  { id: 'bf_emma', label: 'Emma — UK female' },
  { id: 'bm_george', label: 'George — UK male' },
];

// ================================================================ device voices: ranking

const NOVELTY =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|fred|good news|hysterical|jester|junior|kathy|organ|pipe organ|princess|ralph|superstar|trinoids|whisper|wobble|zarvox|espeak|compact)\b/i;

/** Higher = more human-sounding. Unknown/robotic voices score low. */
export function voiceScore(v: SpeechSynthesisVoice): number {
  if (!/^en([-_]|$)/i.test(v.lang)) return -1000;
  if (NOVELTY.test(v.name)) return -500;
  let s = 0;
  const n = v.name;
  if (/natural|neural/i.test(n)) s += 100; // Microsoft Edge "Online (Natural)" voices
  if (/premium/i.test(n)) s += 95; // Apple premium (Siri-grade) voices
  if (/enhanced/i.test(n)) s += 85;
  if (/siri/i.test(n)) s += 85;
  if (/google/i.test(n)) s += 60;
  if (/\b(ava|zoe|evan|nathan|allison|susan|samantha|aria|jenny|guy|libby|sonia|ryan|natasha|william|emma|michelle|christopher|eric|steffan|serena|daniel|karen|moira|tessa)\b/i.test(n)) s += 25;
  const pref = (typeof navigator !== 'undefined' ? navigator.language : 'en-US').toLowerCase();
  if (v.lang.toLowerCase() === pref) s += 15;
  else if (/^en-(us|gb)$/i.test(v.lang)) s += 10;
  if (!v.localService) s += 5; // network voices are usually the neural ones
  return s;
}

export function rankedDeviceVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((v) => voiceScore(v) > -1000)
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}

/** Voices load asynchronously in most browsers. */
export function onVoicesChanged(cb: () => void) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return () => undefined;
  window.speechSynthesis.addEventListener('voiceschanged', cb);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', cb);
}

// ================================================================ Kokoro (Web Worker)

export type KokoroStatus = { state: 'idle' | 'loading' | 'ready' | 'error'; progress?: number; message?: string };

let worker: Worker | null = null;
let kokoroStatus: KokoroStatus = { state: 'idle' };
const statusListeners = new Set<(s: KokoroStatus) => void>();
const pending = new Map<number, { resolve: (a: { samples: Float32Array; rate: number }) => void; reject: (e: Error) => void }>();
let nextId = 1;
let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
/** Set by stopSpeaking() so a multi-phrase announcement stops part-way. */
let stopped = false;

function setStatus(s: KokoroStatus) {
  kokoroStatus = s;
  statusListeners.forEach((l) => l(s));
}

export function getKokoroStatus() {
  return kokoroStatus;
}

export function onKokoroStatus(cb: (s: KokoroStatus) => void) {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'progress') setStatus({ state: 'loading', progress: Math.round(m.progress) });
    else if (m.type === 'ready') setStatus({ state: 'ready' });
    else if (m.type === 'audio') {
      setStatus({ state: 'ready' });
      pending.get(m.id)?.resolve({ samples: m.samples, rate: m.rate });
      pending.delete(m.id);
    } else if (m.type === 'error') {
      setStatus({ state: 'error', message: m.message });
      if (m.id >= 0) {
        pending.get(m.id)?.reject(new Error(m.message));
        pending.delete(m.id);
      }
    }
  };
  worker.onerror = (e) => setStatus({ state: 'error', message: e.message || 'worker failed' });
  return worker;
}

/** Start downloading/initialising the neural voice (e.g. when the user selects it). */
export function preloadKokoro() {
  if (kokoroStatus.state === 'ready' || kokoroStatus.state === 'loading') return;
  setStatus({ state: 'loading', progress: 0 });
  ensureWorker().postMessage({ type: 'load' });
}

/** Call once from a user gesture (browsers block audio until then). */
export function unlockAudio() {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    /* no Web Audio */
  }
}

/**
 * Split an announcement into short phrases so the first one can start playing while the
 * rest are still being generated (cuts the wait before speech starts to ~1–2 s).
 */
function phrases(text: string): string[] {
  const raw = text
    .split(/(?<=[,;:.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of raw) {
    if (out.length && (out[out.length - 1].length < 14 || p.length < 8)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

function generate(w: Worker, text: string, voice: string) {
  const id = nextId++;
  return new Promise<{ samples: Float32Array; rate: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: 'speak', id, text, voice });
  });
}

async function play(samples: Float32Array, rate: number) {
  audioCtx ??= new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const ctx = audioCtx;
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.getChannelData(0).set(samples);
  await new Promise<void>((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      resolve();
    };
    currentSource = src;
    src.start();
  });
}

async function speakKokoro(text: string, voice: string): Promise<void> {
  const w = ensureWorker();
  if (kokoroStatus.state === 'idle' || kokoroStatus.state === 'error') setStatus({ state: 'loading', progress: 0 });
  // Queue every phrase at once (the worker generates them in order); play each as it arrives.
  const jobs = phrases(text).map((p) => generate(w, p, voice));
  jobs.forEach((j) => j.catch(() => undefined)); // later phrases' rejections are handled below
  for (const job of jobs) {
    const { samples, rate } = await job;
    if (stopped) return;
    await play(samples, rate);
    if (stopped) return;
  }
}

// ================================================================ device voice (Web Speech API)

let currentUtterance: SpeechSynthesisUtterance | null = null;

function speakDevice(text: string, voiceName: string | null): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const voices = rankedDeviceVoices();
    const v = (voiceName && voices.find((x) => x.name === voiceName)) || voices[0];
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = 1.0;
    u.pitch = 1.0;
    // Chrome may garbage-collect an unreferenced utterance and never fire onend → keep a
    // reference, and use a watchdog so the queue can never stall.
    currentUtterance = u;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (currentUtterance === u) currentUtterance = null;
      resolve();
    };
    const timer = setTimeout(done, 3_000 + text.length * 80);
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

// ================================================================ public API

export interface VoiceChoice {
  engine: VoiceEngine;
  deviceVoice: string | null;
  kokoroVoice: string;
}

export function ttsSupported() {
  return typeof window !== 'undefined' && ('speechSynthesis' in window || typeof Worker !== 'undefined');
}

/** Speak and resolve when finished. Falls back to the device voice if Kokoro fails. */
export async function speak(text: string, choice: VoiceChoice): Promise<void> {
  stopped = false;
  if (choice.engine === 'kokoro') {
    try {
      await speakKokoro(text, choice.kokoroVoice);
      return;
    } catch {
      /* fall through to the device voice */
    }
  }
  await speakDevice(text, choice.deviceVoice);
}

export function stopSpeaking() {
  stopped = true;
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    currentSource?.stop();
  } catch {
    /* already stopped */
  }
  currentSource = null;
  currentUtterance = null;
}
