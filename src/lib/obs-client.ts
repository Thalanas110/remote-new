import OBSWebSocket from "obs-websocket-js";
import type {
  SceneGuardMetrics,
  SceneGuardReason,
  SceneGuardState,
} from "./obs-scene-guard.ts";
import {
  SCENE_GUARD_ANALYSIS_FORMAT,
  SCENE_GUARD_ANALYSIS_QUALITY,
  SCENE_GUARD_ANALYSIS_WIDTH,
  classifySceneGuardSample,
  createDefaultSceneGuardState,
  isSceneGuardFresh,
} from "./obs-scene-guard.ts";
import { analyzeSceneGuardImageDataUrl } from "./obs-scene-guard.browser.ts";

export type ObsConfig = {
  url: string;
  password?: string;
};

export type ObsProgramMonitorState = {
  imageDataUrl: string | null;
  loading: boolean;
  error?: string;
  lastUpdatedAt: number | null;
};

export type PendingProgramSwitch = {
  sceneName: string;
  reasons: SceneGuardReason[];
  requestedFrom: "directCut" | "transition";
};

export type ObsState = {
  connected: boolean;
  currentScene: string | null;
  scenes: string[];
  sceneGuardEnabled: boolean;
  remoteStudioMode: boolean;
  remotePreviewScene: string | null;
  programMonitor: ObsProgramMonitorState;
  sceneGuard: Record<string, SceneGuardState>;
  pendingProgramSwitch: PendingProgramSwitch | null;
  streaming: boolean;
  recording: boolean;
  recordPaused: boolean;
  virtualCam: boolean;
  error?: string;
};

type ObsClientDeps = {
  analyzeSceneGuardImageDataUrl?: (imageDataUrl: string) => Promise<SceneGuardMetrics>;
  now?: () => number;
};

const PROGRAM_MONITOR_WIDTH = 960;
const PROGRAM_MONITOR_INTERVAL_MS = 1500;

function createDefaultProgramMonitorState(): ObsProgramMonitorState {
  return {
    imageDataUrl: null,
    loading: false,
    error: undefined,
    lastUpdatedAt: null,
  };
}

function createDefaultObsState(): ObsState {
  return {
    connected: false,
    currentScene: null,
    scenes: [],
    sceneGuardEnabled: true,
    remoteStudioMode: false,
    remotePreviewScene: null,
    programMonitor: createDefaultProgramMonitorState(),
    sceneGuard: {},
    pendingProgramSwitch: null,
    streaming: false,
    recording: false,
    recordPaused: false,
    virtualCam: false,
  };
}

function toScreenshotDataUrl(imageData: string, format: string) {
  if (imageData.startsWith("data:")) {
    return imageData;
  }

  return `data:image/${format};base64,${imageData}`;
}

export const defaultObsState: ObsState = createDefaultObsState();

export class ObsClient {
  obs = new OBSWebSocket();
  private listeners = new Set<(s: ObsState) => void>();
  private programMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorRefreshInFlight: Promise<void> | null = null;
  private sceneGuardTimer: ReturnType<typeof setTimeout> | null = null;
  private sceneGuardPassInFlight: Promise<void> | null = null;
  private sceneGuardWatchdogEnabled = false;
  private nextSceneGuardIndex = 0;
  private readonly analyzeSceneGuardImageDataUrl;
  private readonly now;
  state: ObsState = createDefaultObsState();

  constructor(deps: ObsClientDeps = {}) {
    this.analyzeSceneGuardImageDataUrl =
      deps.analyzeSceneGuardImageDataUrl ?? analyzeSceneGuardImageDataUrl;
    this.now = deps.now ?? Date.now;
  }

  subscribe(fn: (s: ObsState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<ObsState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  private updateProgramMonitor(patch: Partial<ObsProgramMonitorState>) {
    this.update({
      programMonitor: {
        ...this.state.programMonitor,
        ...patch,
      },
    });
  }

  private setNextSceneGuardIndex(
    sceneNames: string[],
    prioritySceneName: string | null,
  ) {
    if (sceneNames.length === 0) {
      this.nextSceneGuardIndex = 0;
      return;
    }

    const priorityIndex =
      prioritySceneName == null ? -1 : sceneNames.indexOf(prioritySceneName);

    this.nextSceneGuardIndex =
      priorityIndex >= 0
        ? priorityIndex
        : Math.min(this.nextSceneGuardIndex, sceneNames.length - 1);
  }

  private reconcileSceneGuard(
    sceneNames: string[],
    prioritySceneName: string | null = this.state.currentScene,
  ) {
    const nextSceneGuard: Record<string, SceneGuardState> = {};

    for (const sceneName of sceneNames) {
      nextSceneGuard[sceneName] =
        this.state.sceneGuard[sceneName] ?? createDefaultSceneGuardState();
    }

    this.setNextSceneGuardIndex(sceneNames, prioritySceneName);

    this.update({
      scenes: sceneNames,
      sceneGuard: nextSceneGuard,
    });
  }

  async connect(config: ObsConfig) {
    try {
      this.stopProgramMonitorPolling();
      this.stopSceneGuardWatchdog();
      await this.obs.disconnect().catch(() => {});
      await this.obs.connect(config.url, config.password || undefined);
      this.bindEvents();
      await this.refreshAll();
      this.update({ connected: true, error: undefined });
      await this.refreshProgramMonitor();
      this.startProgramMonitorPolling();
      this.sceneGuardWatchdogEnabled = true;
      this.scheduleSceneGuardPass();
    } catch (e: any) {
      this.stopProgramMonitorPolling();
      this.stopSceneGuardWatchdog();
      this.monitorRefreshInFlight = null;
      this.sceneGuardPassInFlight = null;
      this.sceneGuardWatchdogEnabled = false;
      this.update({
        connected: false,
        error: e?.message ?? "Failed to connect",
        programMonitor: createDefaultProgramMonitorState(),
        sceneGuard: {},
        pendingProgramSwitch: null,
      });
      throw e;
    }
  }

  async disconnect() {
    this.stopProgramMonitorPolling();
    this.stopSceneGuardWatchdog();
    this.monitorRefreshInFlight = null;
    this.sceneGuardPassInFlight = null;
    this.sceneGuardWatchdogEnabled = false;
    await this.obs.disconnect().catch(() => {});
    this.update(createDefaultObsState());
  }

  private bindEvents() {
    this.obs.off("ConnectionClosed" as any);
    this.obs.off("CurrentProgramSceneChanged" as any);
    this.obs.off("SceneListChanged" as any);
    this.obs.off("StreamStateChanged" as any);
    this.obs.off("RecordStateChanged" as any);
    this.obs.off("VirtualcamStateChanged" as any);
    this.obs.on("ConnectionClosed", () => {
      this.stopProgramMonitorPolling();
      this.stopSceneGuardWatchdog();
      this.monitorRefreshInFlight = null;
      this.sceneGuardPassInFlight = null;
      this.sceneGuardWatchdogEnabled = false;
      this.update({
        connected: false,
        programMonitor: createDefaultProgramMonitorState(),
        sceneGuard: {},
        pendingProgramSwitch: null,
      });
    });
    this.obs.on("CurrentProgramSceneChanged", (d: any) => {
      this.update({
        currentScene: d.sceneName,
        remotePreviewScene: this.state.remoteStudioMode
          ? this.state.remotePreviewScene
          : d.sceneName,
      });
      this.setNextSceneGuardIndex(this.state.scenes, d.sceneName);
      this.scheduleSceneGuardPass();
      void this.refreshProgramMonitor();
    });
    this.obs.on("SceneListChanged", (d: any) => {
      this.reconcileSceneGuard(
        d.scenes.map((s: any) => s.sceneName).reverse(),
        this.state.currentScene,
      );
      this.scheduleSceneGuardPass();
    });
    this.obs.on("StreamStateChanged", (d: any) =>
      this.update({ streaming: d.outputActive })
    );
    this.obs.on("RecordStateChanged", (d: any) =>
      this.update({ recording: d.outputActive, recordPaused: d.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED" })
    );
    this.obs.on("VirtualcamStateChanged", (d: any) =>
      this.update({ virtualCam: d.outputActive })
    );
  }

  private startProgramMonitorPolling() {
    if (this.programMonitorTimer) {
      return;
    }

    this.programMonitorTimer = setInterval(() => {
      void this.refreshProgramMonitor();
    }, PROGRAM_MONITOR_INTERVAL_MS);
    this.programMonitorTimer.unref?.();
  }

  private stopProgramMonitorPolling() {
    if (!this.programMonitorTimer) {
      return;
    }

    clearInterval(this.programMonitorTimer);
    this.programMonitorTimer = null;
  }

  private scheduleSceneGuardPass() {
    if (
      this.sceneGuardTimer ||
      !this.sceneGuardWatchdogEnabled ||
      !this.state.connected ||
      this.state.scenes.length === 0
    ) {
      return;
    }

    this.sceneGuardTimer = setTimeout(() => {
      this.sceneGuardTimer = null;
      void this.runSceneGuardPass();
    }, 0);
    this.sceneGuardTimer.unref?.();
  }

  private stopSceneGuardWatchdog() {
    if (!this.sceneGuardTimer) {
      return;
    }

    clearTimeout(this.sceneGuardTimer);
    this.sceneGuardTimer = null;
  }

  private async refreshProgramMonitor() {
    const sceneName = this.state.currentScene;
    if (!sceneName) {
      return;
    }

    if (this.monitorRefreshInFlight) {
      return this.monitorRefreshInFlight;
    }

    this.updateProgramMonitor({
      loading: true,
      error: undefined,
    });

    this.monitorRefreshInFlight = (async () => {
      try {
        const result: any = await this.obs.call("GetSourceScreenshot", {
          sourceName: sceneName,
          imageFormat: "jpeg",
          imageWidth: PROGRAM_MONITOR_WIDTH,
          imageCompressionQuality: 75,
        });

        this.updateProgramMonitor({
          imageDataUrl: toScreenshotDataUrl(result.imageData, "jpeg"),
          loading: false,
          error: undefined,
          lastUpdatedAt: Date.now(),
        });
      } catch (e: any) {
        this.updateProgramMonitor({
          loading: false,
          error: e?.message ?? "Monitor refresh failed",
        });
      } finally {
        this.monitorRefreshInFlight = null;
      }
    })();

    return this.monitorRefreshInFlight;
  }

  private async runSceneGuardPass() {
    if (!this.state.connected || this.state.scenes.length === 0) {
      return;
    }

    if (this.sceneGuardPassInFlight) {
      return this.sceneGuardPassInFlight;
    }

    const sceneName = this.state.scenes[this.nextSceneGuardIndex];

    this.sceneGuardPassInFlight = (async () => {
      try {
        const screenshot: any = await this.obs.call("GetSourceScreenshot", {
          sourceName: sceneName,
          imageFormat: SCENE_GUARD_ANALYSIS_FORMAT,
          imageWidth: SCENE_GUARD_ANALYSIS_WIDTH,
          imageCompressionQuality: SCENE_GUARD_ANALYSIS_QUALITY,
        });

        const imageDataUrl = toScreenshotDataUrl(
          screenshot.imageData,
          SCENE_GUARD_ANALYSIS_FORMAT,
        );
        const metrics = await this.analyzeSceneGuardImageDataUrl(imageDataUrl);
        const previous =
          this.state.sceneGuard[sceneName] ?? createDefaultSceneGuardState();

        this.update({
          sceneGuard: {
            ...this.state.sceneGuard,
            [sceneName]: classifySceneGuardSample(previous, metrics, this.now()),
          },
        });
      } catch {
        this.update({
          sceneGuard: {
            ...this.state.sceneGuard,
            [sceneName]: createDefaultSceneGuardState(),
          },
        });
      } finally {
        this.sceneGuardPassInFlight = null;
        this.nextSceneGuardIndex =
          this.state.scenes.length === 0
            ? 0
            : (this.nextSceneGuardIndex + 1) % this.state.scenes.length;
        if (this.sceneGuardWatchdogEnabled) {
          this.scheduleSceneGuardPass();
        }
      }
    })();

    return this.sceneGuardPassInFlight;
  }

  private getFreshSceneGuard(sceneName: string) {
    const sceneGuard = this.state.sceneGuard[sceneName];

    if (!isSceneGuardFresh(sceneGuard, this.now())) {
      return null;
    }

    return sceneGuard;
  }

  private async sendProgramScene(
    sceneName: string,
    requestedFrom: PendingProgramSwitch["requestedFrom"],
  ) {
    await this.obs.call("SetCurrentProgramScene", { sceneName });

    if (requestedFrom === "transition") {
      this.update({ currentScene: sceneName });
      this.setNextSceneGuardIndex(this.state.scenes, sceneName);
      await this.refreshProgramMonitor();
    }
  }

  private async requestProgramScene(
    sceneName: string,
    requestedFrom: PendingProgramSwitch["requestedFrom"],
  ) {
    if (!this.state.sceneGuardEnabled) {
      await this.sendProgramScene(sceneName, requestedFrom);
      return;
    }

    const sceneGuard = this.getFreshSceneGuard(sceneName);

    if (sceneGuard?.status === "flagged" && sceneGuard.reasons.length > 0) {
      this.update({
        pendingProgramSwitch: {
          sceneName,
          reasons: sceneGuard.reasons,
          requestedFrom,
        },
      });
      return;
    }

    await this.sendProgramScene(sceneName, requestedFrom);
  }

  async refreshAll() {
    const sceneList: any = await this.obs.call("GetSceneList");
    const stream: any = await this.obs.call("GetStreamStatus");
    const record: any = await this.obs.call("GetRecordStatus");
    let vcam = false;
    try {
      const v: any = await this.obs.call("GetVirtualCamStatus");
      vcam = v.outputActive;
    } catch {}
    const scenes = sceneList.scenes.map((s: any) => s.sceneName).reverse();
    this.reconcileSceneGuard(scenes, sceneList.currentProgramSceneName);
    this.update({
      currentScene: sceneList.currentProgramSceneName,
      remotePreviewScene:
        this.state.remoteStudioMode && this.state.remotePreviewScene
          ? this.state.remotePreviewScene
          : sceneList.currentProgramSceneName,
      streaming: stream.outputActive,
      recording: record.outputActive,
      recordPaused: record.outputPaused,
      virtualCam: vcam,
    });
  }

  async setScene(name: string) {
    if (this.state.remoteStudioMode) {
      this.update({ remotePreviewScene: name });
      return;
    }

    await this.requestProgramScene(name, "directCut");
  }
  setProgramScene(name: string) {
    return this.requestProgramScene(name, "directCut");
  }
  async triggerTransition() {
    const sceneName = this.state.remotePreviewScene;
    if (!sceneName || sceneName === this.state.currentScene) {
      return;
    }

    await this.requestProgramScene(sceneName, "transition");
  }
  toggleRemoteStudio() {
    const next = !this.state.remoteStudioMode;
    this.update({
      remoteStudioMode: next,
      remotePreviewScene: next
        ? this.state.remotePreviewScene ?? this.state.currentScene
        : this.state.currentScene,
    });
  }
  toggleStudio() {
    this.toggleRemoteStudio();
  }
  toggleSceneGuard() {
    const next = !this.state.sceneGuardEnabled;
    this.update({
      sceneGuardEnabled: next,
      pendingProgramSwitch: next ? this.state.pendingProgramSwitch : null,
    });
  }
  toggleStream() {
    return this.obs.call("ToggleStream");
  }
  toggleRecord() {
    return this.obs.call("ToggleRecord");
  }
  toggleRecordPause() {
    return this.obs.call("ToggleRecordPause");
  }
  toggleVirtualCam() {
    return this.obs.call("ToggleVirtualCam");
  }
  async confirmPendingProgramSwitch() {
    const pending = this.state.pendingProgramSwitch;
    if (!pending) {
      return;
    }

    if (!this.state.scenes.includes(pending.sceneName)) {
      this.update({ pendingProgramSwitch: null });
      return;
    }

    this.update({ pendingProgramSwitch: null });
    await this.sendProgramScene(pending.sceneName, pending.requestedFrom);
  }
  cancelPendingProgramSwitch() {
    this.update({ pendingProgramSwitch: null });
  }
}

export const obsClient = new ObsClient();
