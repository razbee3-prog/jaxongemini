/** Minimal Gemini Live (BidiGenerateContent) client over a raw WebSocket. Works in browsers and Node 22+. */

export interface FunctionCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}
export interface FunctionResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export type LiveStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface LiveHandlers {
  onAudio?: (pcm16b64: string) => void;
  onInterrupted?: () => void;
  onInputText?: (text: string) => void;
  onOutputText?: (text: string) => void;
  onTurnComplete?: () => void;
  onToolCall?: (calls: FunctionCall[]) => void;
  onStatus?: (s: LiveStatus) => void;
  onError?: (message: string) => void;
}

export interface TokenInfo {
  token: string;
  model: string;
  /** BidiGenerateContentSetup without sessionResumption. */
  setup: Record<string, unknown>;
}

const WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

type ServerMessage = {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data: string; mimeType?: string }; text?: string }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: FunctionCall[] };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
  error?: { message?: string };
};

async function decode(data: unknown): Promise<ServerMessage> {
  if (typeof data === "string") return JSON.parse(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return JSON.parse(await data.text());
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
  return JSON.parse(String(data));
}

export class LiveClient {
  status: LiveStatus = "closed";
  /** Latest session resumption handle; reconnects resume the same conversation. */
  handle: string | null = null;
  private ws: WebSocket | null = null;
  private tokenInfo: TokenInfo | null = null;
  private closedByUser = false;
  private pending: string[] = [];
  private reconnects = 0;
  private getToken: () => Promise<TokenInfo>;
  private h: LiveHandlers;

  constructor(getToken: () => Promise<TokenInfo>, handlers: LiveHandlers) {
    this.getToken = getToken;
    this.h = handlers;
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    this.h.onStatus?.(s);
  }

  /** Reconnects reuse the current token (it allows several uses) so the session can resume; a failed reuse fetches a new one. */
  async connect(fresh = true, reconnecting = false): Promise<void> {
    if (!reconnecting) this.closedByUser = false;
    this.setStatus(this.handle ? "reconnecting" : "connecting");
    if (fresh || !this.tokenInfo) this.tokenInfo = await this.getToken();
    if (this.closedByUser) return;
    const { token, setup } = this.tokenInfo;
    const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(token)}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ setup: { ...setup, sessionResumption: this.handle ? { handle: this.handle } : {} } }));
      };
      ws.onmessage = async (ev) => {
        let msg: ServerMessage;
        try {
          msg = await decode(ev.data);
        } catch {
          return;
        }
        if (msg.setupComplete !== undefined && !ready) {
          ready = true;
          this.reconnects = 0;
          this.setStatus("open");
          for (const m of this.pending.splice(0)) ws.send(m);
          resolve();
          return;
        }
        this.dispatch(msg);
      };
      ws.onerror = () => {
        if (!ready) reject(new Error("Could not connect to Gemini Live"));
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (!ready) {
          reject(new Error(`Gemini Live closed during setup (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`));
          return;
        }
        if (this.closedByUser) this.setStatus("closed");
        else void this.reconnect(`${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`);
      };
    });
  }

  private async reconnect(why: string) {
    if (this.closedByUser) return;
    if (this.reconnects++ >= 5) {
      this.setStatus("closed");
      this.h.onError?.(`Lost connection to Jax (${why})`);
      return;
    }
    this.setStatus("reconnecting");
    await new Promise((r) => setTimeout(r, Math.min(4000, 300 * 2 ** this.reconnects)));
    if (this.closedByUser) return;
    try {
      await this.connect(this.reconnects > 2, true);
    } catch (e) {
      void this.reconnect(String(e));
    }
  }

  private dispatch(msg: ServerMessage) {
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.h.onInterrupted?.();
      for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) this.h.onAudio?.(p.inlineData.data);
      if (sc.inputTranscription?.text) this.h.onInputText?.(sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.h.onOutputText?.(sc.outputTranscription.text);
      if (sc.turnComplete) this.h.onTurnComplete?.();
    }
    if (msg.toolCall?.functionCalls?.length) this.h.onToolCall?.(msg.toolCall.functionCalls);
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) this.handle = msg.sessionResumptionUpdate.newHandle;
    if (msg.goAway) {
      // The server is about to drop this connection: move to a fresh one now, resuming the session.
      const old = this.ws;
      this.ws = null;
      old?.close();
      void this.reconnect("goAway");
    }
    if (msg.error?.message) this.h.onError?.(msg.error.message);
  }

  private send(obj: unknown, queue: boolean) {
    const s = JSON.stringify(obj);
    if (this.ws && this.status === "open" && this.ws.readyState === 1) this.ws.send(s);
    else if (queue) this.pending.push(s);
  }

  /** 16-bit little-endian PCM, base64. Dropped while reconnecting. */
  sendAudio(b64: string, rate: number) {
    this.send({ realtimeInput: { audio: { data: b64, mimeType: `audio/pcm;rate=${rate}` } } }, false);
  }

  /** One JPEG camera frame, base64 (max ~1 fps). Dropped while reconnecting. */
  sendVideo(b64: string) {
    this.send({ realtimeInput: { video: { data: b64, mimeType: "image/jpeg" } } }, false);
  }

  /** Text that Jax should respond to (starts a model turn). */
  sendText(text: string) {
    this.send({ realtimeInput: { text } }, true);
  }

  /** Background context that should not by itself trigger a reply. */
  sendContext(text: string) {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false } }, true);
  }

  sendToolResponse(functionResponses: FunctionResponse[]) {
    this.send({ toolResponse: { functionResponses } }, true);
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }
}
