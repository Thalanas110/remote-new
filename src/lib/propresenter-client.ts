import { propresenterRequest } from "./api/propresenter.functions.ts";

// ProPresenter REST API client
// Default host: http://<computer-ip>:50001  (or the custom port set in Network prefs)

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

export type PpTransportRequest = {
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
};

type PpClientDeps = {
  request?: (request: PpTransportRequest) => Promise<unknown>;
  setIntervalFn?: typeof globalThis.setInterval;
  clearIntervalFn?: typeof globalThis.clearInterval;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function getVersionLabel(version: unknown) {
  if (typeof version === "string") {
    return version;
  }
  if (!isRecord(version)) {
    return "connected";
  }
  if (typeof version.name === "string") {
    return version.name;
  }
  if (typeof version.version === "string") {
    return version.version;
  }
  return "connected";
}

function getActivePresentationName(active: unknown) {
  if (!isRecord(active)) {
    return undefined;
  }
  if (typeof active.name === "string") {
    return active.name;
  }
  const presentation = active.presentation;
  if (isRecord(presentation) && typeof presentation.name === "string") {
    return presentation.name;
  }
  return undefined;
}

function getCurrentSlideIndex(slide: unknown) {
  if (!isRecord(slide)) {
    return undefined;
  }
  const presentationIndex = slide.presentation_index;
  if (isRecord(presentationIndex) && typeof presentationIndex.index === "number") {
    return presentationIndex.index;
  }
  if (typeof slide.index === "number") {
    return slide.index;
  }
  return undefined;
}

function getTotalSlides(active: unknown, slide: unknown) {
  if (isRecord(slide)) {
    const presentationIndex = slide.presentation_index;
    if (isRecord(presentationIndex) && typeof presentationIndex.count === "number") {
      return presentationIndex.count;
    }
    if (Array.isArray(slide.slides)) {
      return slide.slides.length;
    }
  }
  if (!isRecord(active)) {
    return undefined;
  }
  const presentation = active.presentation;
  if (isRecord(presentation) && Array.isArray(presentation.slides)) {
    return presentation.slides.length;
  }
  return undefined;
}

const CLEARABLE_LAYERS = [
  "audio",
  "props",
  "messages",
  "announcements",
  "slide",
  "media",
  "video_input",
] as const;

export class PpClient {
  config: PpConfig = { baseUrl: "" };
  state: PpState = { ...defaultPpState };
  private listeners = new Set<(s: PpState) => void>();
  private poll: ReturnType<typeof globalThis.setInterval> | null = null;
  private readonly request;
  private readonly setIntervalFn;
  private readonly clearIntervalFn;

  constructor(deps: PpClientDeps = {}) {
    this.request =
      deps.request ??
      ((request: PpTransportRequest) => propresenterRequest({ data: request }));
    this.setIntervalFn = deps.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn =
      deps.clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);
  }

  subscribe(fn: (s: PpState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  private update(patch: Partial<PpState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  private async req(path: string, method: "GET" | "POST" = "GET") {
    return this.request({
      baseUrl: this.config.baseUrl,
      path,
      method,
    });
  }

  async connect(config: PpConfig) {
    this.config = config;
    try {
      const version = await this.req("/version");
      this.update({
        connected: true,
        version: getVersionLabel(version),
        error: undefined,
      });
      await this.refresh();
      this.startPolling();
    } catch (e: any) {
      this.update({ connected: false, error: e?.message ?? "Failed to connect" });
      throw e;
    }
  }

  disconnect() {
    if (this.poll) {
      this.clearIntervalFn(this.poll);
    }
    this.poll = null;
    this.update({ ...defaultPpState });
  }

  private startPolling() {
    if (this.poll) {
      this.clearIntervalFn(this.poll);
    }
    this.poll = this.setIntervalFn(() => {
      void this.refresh();
    }, 1500);
  }

  async refresh() {
    try {
      const active = await this.req("/v1/presentation/active").catch(() => null);
      const slide = await this.req("/v1/presentation/slide_index").catch(() => null);
      this.update({
        activePresentationName: getActivePresentationName(active),
        currentSlideIndex: getCurrentSlideIndex(slide),
        totalSlides: getTotalSlides(active, slide),
      });
    } catch {}
  }

  next() { return this.req("/v1/presentation/active/next/trigger"); }
  prev() { return this.req("/v1/presentation/active/previous/trigger"); }
  triggerIndex(i: number) { return this.req(`/v1/presentation/active/${i}/trigger`); }
  async clearAll() {
    for (const layer of CLEARABLE_LAYERS) {
      await this.req(`/v1/clear/layer/${layer}`);
    }
  }
  clearSlide() { return this.req("/v1/clear/layer/slide"); }
  clearProps() { return this.req("/v1/clear/layer/props"); }
  clearMessages() { return this.req("/v1/clear/layer/messages"); }
  clearAudio() { return this.req("/v1/clear/layer/audio"); }
  clearAnnouncements() { return this.req("/v1/clear/layer/announcements"); }
  toggleLogo() {
    return this.req("/v1/status/screens")
      .then(() => this.req("/v1/trigger/media/next", "POST"))
      .catch(() => {});
  }
  timerStart(id: string) { return this.req(`/v1/timer/${encodeURIComponent(id)}/start`); }
  timerStop(id: string) { return this.req(`/v1/timer/${encodeURIComponent(id)}/stop`); }
  timerReset(id: string) { return this.req(`/v1/timer/${encodeURIComponent(id)}/reset`); }
  audienceScreenToggle() { return this.req("/v1/status/audience_screen"); }
}

export const ppClient = new PpClient();
