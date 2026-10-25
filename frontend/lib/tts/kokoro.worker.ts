/// <reference lib="webworker" />
// Runs the Kokoro neural TTS model off the main thread (so the map never stutters).
import { KokoroTTS } from 'kokoro-js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let ready: Promise<KokoroTTS> | null = null;

function load() {
  ready ??= KokoroTTS.from_pretrained(MODEL, {
    dtype: 'q8', // ~90 MB, good quality; cached by the browser after the first download
    device: 'wasm',
    progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
      if (p.status === 'progress' && typeof p.progress === 'number') postMessage({ type: 'progress', progress: p.progress, file: p.file });
    },
  });
  return ready;
}

type Msg = { type: 'load' } | { type: 'speak'; id: number; text: string; voice: string };

// Handle requests strictly one at a time, in order (phrases of one announcement are queued together).
let chain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Msg>) => {
  chain = chain.then(() => handle(e.data));
};

async function handle(msg: Msg) {
  try {
    const tts = await load();
    if (msg.type === 'load') {
      postMessage({ type: 'ready' });
      return;
    }
    const out = await tts.generate(msg.text, { voice: msg.voice as never });
    const samples = out.audio as Float32Array;
    postMessage({ type: 'audio', id: msg.id, samples, rate: out.sampling_rate }, { transfer: [samples.buffer] });
  } catch (err) {
    ready = null; // allow a retry later
    postMessage({ type: 'error', id: 'id' in msg ? msg.id : -1, message: (err as Error).message });
  }
}
