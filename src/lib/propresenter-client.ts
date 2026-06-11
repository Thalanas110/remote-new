// ProPresenter 7 REST API client
// Default host: http://<computer-ip>:1025  (must enable Network in PP7 prefs)

export type PpConfig = {
  baseUrl: string; // e.g. http://192.168.1.20:1025
};

export type PpState = {
  connected: boolean;
  version?: string;
  activePresentationName?: string;
  currentSlideIndex?: number;
  totalSlides?: number;
  stageMessage?: string;
  error?: string;
};

export const defaultPpState: PpState = { connected: false };

export class PpClient {
  config: PpConfig = { baseUrl: "" };
  state: PpState = { ...defaultPpState };
  private listeners = new Set<(s: PpState) => void>();
  private poll?: number;

  subscribe(fn: (s: PpState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  private update(patch: Partial<PpState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  private async req(path: string, init?: RequestInit) {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async connect(config: PpConfig) {
    this.config = config;
    try {
      const v = await this.req("/version");
      this.update({ connected: true, version: v?.name || v?.version || "connected", error: undefined });
      this.startPolling();
    } catch (e: any) {
      this.update({ connected: false, error: e?.message ?? "Failed to connect" });
      throw e;
    }
  }

  disconnect() {
    if (this.poll) window.clearInterval(this.poll);
    this.poll = undefined;
    this.update({ ...defaultPpState });
  }

  private startPolling() {
    if (this.poll) window.clearInterval(this.poll);
    this.poll = window.setInterval(() => this.refresh().catch(() => {}), 1500);
    this.refresh().catch(() => {});
  }

  async refresh() {
    try {
      const active = await this.req("/v1/presentation/active").catch(() => null);
      const slide = await this.req("/v1/presentation/slide_index").catch(() => null);
      this.update({
        activePresentationName: active?.presentation?.name || active?.name,
        currentSlideIndex: typeof slide?.presentation_index?.index === "number" ? slide.presentation_index.index : slide?.index,
      });
    } catch {}
  }

  next() { return this.req("/v1/trigger/next", { method: "POST" }); }
  prev() { return this.req("/v1/trigger/previous", { method: "POST" }); }
  triggerIndex(i: number) { return this.req(`/v1/presentation/active/${i}/trigger`, { method: "POST" }); }
  clearAll() { return this.req("/v1/clear/layer/all", { method: "POST" }); }
  clearSlide() { return this.req("/v1/clear/layer/presentation", { method: "POST" }); }
  clearProps() { return this.req("/v1/clear/layer/props", { method: "POST" }); }
  clearMessages() { return this.req("/v1/clear/layer/messages", { method: "POST" }); }
  clearAudio() { return this.req("/v1/clear/layer/audio", { method: "POST" }); }
  clearAnnouncements() { return this.req("/v1/clear/layer/announcements", { method: "POST" }); }
  toggleLogo() { return this.req("/v1/status/screens", { method: "GET" }).then(() => this.req("/v1/trigger/media/next", { method: "POST" })).catch(() => {}); }
  timerStart(id: string) { return this.req(`/v1/timer/${encodeURIComponent(id)}/start`, { method: "POST" }); }
  timerStop(id: string) { return this.req(`/v1/timer/${encodeURIComponent(id)}/stop`, { method: "POST" }); }
  timerReset(id: string) { return this.req(`/v1/timer/${encodeURIComponent(id)}/reset`, { method: "POST" }); }
  audienceScreenToggle() { return this.req("/v1/status/audience_screen", { method: "GET" }); }
}

export const ppClient = new PpClient();
