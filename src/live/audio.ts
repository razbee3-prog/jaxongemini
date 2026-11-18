/** Mic capture (16-bit PCM chunks) and gapless playback of Gemini's 24 kHz PCM replies. */

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  muted = false;
  /** Rough 0..1 input level for the UI. */
  level = 0;

  async start(stream: MediaStream, onChunk: (b64: string, rate: number) => void) {
    // Ask for 16 kHz (Gemini's native rate); browsers that refuse get their default rate, which the API resamples.
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      this.ctx = new AudioContext();
    }
    await this.ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
    this.src = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    const rate = this.ctx.sampleRate;
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const pcm = new Int16Array(e.data);
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
      this.level = this.muted ? 0 : peak / 32768;
      if (!this.muted) onChunk(bytesToB64(new Uint8Array(e.data)), rate);
    };
    // Route through a muted gain to the destination so every browser keeps pulling (and running) the worklet.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.node).connect(this.sink).connect(this.ctx.destination);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  stop() {
    this.src?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    void this.ctx?.close();
    this.ctx = this.node = this.src = this.sink = null;
  }
}

export class PcmPlayer {
  private ctx: AudioContext;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private rate: number;

  constructor(rate = 24000) {
    this.rate = rate;
    this.ctx = new AudioContext({ sampleRate: rate });
  }

  /** Must be called from a user gesture on iOS. */
  unlock() {
    void this.ctx.resume();
  }

  get speaking() {
    return this.sources.size > 0;
  }

  play(b64: string) {
    const bytes = b64ToBytes(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const buf = this.ctx.createBuffer(1, pcm.length, this.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime + 0.03, this.nextTime);
    src.start(t);
    this.nextTime = t + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** Drop everything queued (the user barged in). */
  interrupt() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
  }

  close() {
    this.interrupt();
    void this.ctx.close();
  }
}
