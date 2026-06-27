import { propresenterRequest } from "./api/propresenter.functions.ts";
import {
  PP_PATHS,
  errorMessage,
  normalizeProPresenterBaseUrl,
  parseActivePresentation,
  parseSlideIndex,
  parseVersion,
  type PpPresentationSnapshot,
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
}

export const ppClient = new PpClient();
