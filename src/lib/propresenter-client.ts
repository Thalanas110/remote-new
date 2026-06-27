import { propresenterRequest } from "./api/propresenter.functions.ts";
import {
  CLEARABLE_LAYERS,
  PP_PATHS,
  buildClearLayerPath,
  buildTimerPath,
  errorMessage,
  normalizeProPresenterBaseUrl,
  parseActivePresentation,
  parseSlideIndex,
  parseVersion,
  type ClearableLayer,
  type PpPresentationSnapshot,
  type TimerOperation,
} from "./propresenter-contract.ts";
import type { ProPresenterRequest as PpTransportRequest } from "./propresenter-request.ts";

export type { PpTransportRequest };

export type PpConfig = { baseUrl: string };
export type PpActionGroup = "navigation" | "clear" | "timer";
export type PpState = PpPresentationSnapshot & {
  connected: boolean;
  degraded: boolean;
  machineName?: string;
  hostDescription?: string;
  apiVersion?: string;
  refreshError?: string;
  actionError?: string;
  activeAction?: PpActionGroup;
};

export const defaultPpState: PpState = { connected: false, degraded: false };

type PpClientDeps = {
  request?: (request: PpTransportRequest) => Promise<unknown>;
  setIntervalFn?: typeof globalThis.setInterval;
  clearIntervalFn?: typeof globalThis.clearInterval;
};

export class PpClient {
  config: PpConfig = { baseUrl: "" };
  state: PpState = { ...defaultPpState };
  private listeners = new Set<(state: PpState) => void>();
  private poll: ReturnType<typeof globalThis.setInterval> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private consecutiveRefreshFailures = 0;
  private generation = 0;
  private readonly request: (request: PpTransportRequest) => Promise<unknown>;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;

  constructor(deps: PpClientDeps = {}) {
    this.request = deps.request ?? ((request) => propresenterRequest({ data: request }));
    this.setIntervalFn = deps.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = deps.clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);
  }

  subscribe(listener: (state: PpState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<PpState>) {
    const next = { ...this.state, ...patch } as PpState & Record<string, unknown>;
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    this.state = next;
    this.listeners.forEach((listener) => listener(this.state));
  }

  private req(path: string, method: "GET" | "PUT" = "GET", body?: unknown) {
    return this.request({ baseUrl: this.config.baseUrl, path, method, body });
  }

  private stopPolling() {
    if (this.poll !== null) this.clearIntervalFn(this.poll);
    this.poll = null;
  }

  private startPolling() {
    this.stopPolling();
    this.poll = this.setIntervalFn(() => void this.refresh(), 1500);
  }

  async connect(config: PpConfig) {
    this.stopPolling();
    const generation = ++this.generation;
    this.config = { baseUrl: normalizeProPresenterBaseUrl(config.baseUrl) };
    this.state = { ...defaultPpState };
    try {
      const host = parseVersion(await this.req(PP_PATHS.version));
      if (generation !== this.generation) return;
      this.update({ connected: true, ...host });
      await this.refresh();
      if (generation === this.generation) this.startPolling();
    } catch (error) {
      if (generation === this.generation) {
        this.update({
          connected: false,
          refreshError: errorMessage(error, "Failed to connect"),
        });
      }
      throw error;
    }
  }

  disconnect() {
    this.generation += 1;
    this.stopPolling();
    this.refreshPromise = null;
    this.consecutiveRefreshFailures = 0;
    this.state = { ...defaultPpState };
    this.listeners.forEach((listener) => listener(this.state));
  }

  refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const refreshPromise = (async () => {
      try {
        const [activePayload, indexPayload] = await Promise.all([
          this.req(PP_PATHS.activePresentation),
          this.req(PP_PATHS.slideIndex),
        ]);
        const active = parseActivePresentation(activePayload);
        const currentSlideIndex = parseSlideIndex(indexPayload);
        if (generation !== this.generation) return;
        this.consecutiveRefreshFailures = 0;
        this.update({
          connected: true,
          degraded: false,
          refreshError: undefined,
          ...active,
          currentSlideIndex,
        });
      } catch (error) {
        if (generation !== this.generation) return;
        this.consecutiveRefreshFailures += 1;
        this.update({
          connected: this.consecutiveRefreshFailures < 3,
          degraded: true,
          refreshError: errorMessage(error, "Could not refresh ProPresenter"),
        });
      }
    })();
    this.refreshPromise = refreshPromise;
    void refreshPromise.finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
    });
    return refreshPromise;
  }

  private async runAction(
    group: PpActionGroup,
    operation: () => Promise<void>,
    refreshAfter = false,
  ) {
    if (this.state.activeAction === group) return;
    this.update({ activeAction: group, actionError: undefined });
    try {
      await operation();
      if (refreshAfter) await this.refresh();
    } catch (error) {
      this.update({ actionError: errorMessage(error, "ProPresenter command failed") });
      throw error;
    } finally {
      if (this.state.activeAction === group) this.update({ activeAction: undefined });
    }
  }

  previous() {
    return this.runAction(
      "navigation",
      async () => {
        await this.req(PP_PATHS.previous);
      },
      true,
    );
  }

  next() {
    return this.runAction(
      "navigation",
      async () => {
        await this.req(PP_PATHS.next);
      },
      true,
    );
  }

  clearLayer(layer: ClearableLayer) {
    return this.runAction("clear", async () => {
      await this.req(buildClearLayerPath(layer));
    });
  }

  clearSlide() {
    return this.clearLayer("slide");
  }

  clearProps() {
    return this.clearLayer("props");
  }

  clearMessages() {
    return this.clearLayer("messages");
  }

  clearAudio() {
    return this.clearLayer("audio");
  }

  clearAnnouncements() {
    return this.clearLayer("announcements");
  }

  clearAll() {
    return this.runAction("clear", async () => {
      for (const layer of CLEARABLE_LAYERS) {
        await this.req(buildClearLayerPath(layer));
      }
    });
  }

  private timer(id: string, operation: TimerOperation) {
    return this.runAction(
      "timer",
      async () => {
        await this.req(buildTimerPath(id, operation));
      },
      true,
    );
  }

  timerStart(id: string) {
    return this.timer(id, "start");
  }

  timerStop(id: string) {
    return this.timer(id, "stop");
  }

  timerReset(id: string) {
    return this.timer(id, "reset");
  }
}

export const ppClient = new PpClient();
