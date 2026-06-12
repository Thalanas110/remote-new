import OBSWebSocket from "obs-websocket-js";

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

export type ObsState = {
  connected: boolean;
  currentScene: string | null;
  scenes: string[];
  remoteStudioMode: boolean;
  remotePreviewScene: string | null;
  programMonitor: ObsProgramMonitorState;
  streaming: boolean;
  recording: boolean;
  recordPaused: boolean;
  virtualCam: boolean;
  error?: string;
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
    remoteStudioMode: false,
    remotePreviewScene: null,
    programMonitor: createDefaultProgramMonitorState(),
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
  state: ObsState = createDefaultObsState();

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

  async connect(config: ObsConfig) {
    try {
      this.stopProgramMonitorPolling();
      await this.obs.disconnect().catch(() => {});
      await this.obs.connect(config.url, config.password || undefined);
      this.bindEvents();
      await this.refreshAll();
      this.update({ connected: true, error: undefined });
      await this.refreshProgramMonitor();
      this.startProgramMonitorPolling();
    } catch (e: any) {
      this.stopProgramMonitorPolling();
      this.monitorRefreshInFlight = null;
      this.update({
        connected: false,
        error: e?.message ?? "Failed to connect",
        programMonitor: createDefaultProgramMonitorState(),
      });
      throw e;
    }
  }

  async disconnect() {
    this.stopProgramMonitorPolling();
    this.monitorRefreshInFlight = null;
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
      this.monitorRefreshInFlight = null;
      this.update({
        connected: false,
        programMonitor: createDefaultProgramMonitorState(),
      });
    });
    this.obs.on("CurrentProgramSceneChanged", (d: any) => {
      this.update({
        currentScene: d.sceneName,
        remotePreviewScene: this.state.remoteStudioMode
          ? this.state.remotePreviewScene
          : d.sceneName,
      });
      void this.refreshProgramMonitor();
    });
    this.obs.on("SceneListChanged", (d: any) =>
      this.update({ scenes: d.scenes.map((s: any) => s.sceneName).reverse() })
    );
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
  }

  private stopProgramMonitorPolling() {
    if (!this.programMonitorTimer) {
      return;
    }

    clearInterval(this.programMonitorTimer);
    this.programMonitorTimer = null;
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

  async refreshAll() {
    const sceneList: any = await this.obs.call("GetSceneList");
    const stream: any = await this.obs.call("GetStreamStatus");
    const record: any = await this.obs.call("GetRecordStatus");
    let vcam = false;
    try {
      const v: any = await this.obs.call("GetVirtualCamStatus");
      vcam = v.outputActive;
    } catch {}
    this.update({
      scenes: sceneList.scenes.map((s: any) => s.sceneName).reverse(),
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

    await this.obs.call("SetCurrentProgramScene", { sceneName: name });
  }
  setProgramScene(name: string) {
    return this.obs.call("SetCurrentProgramScene", { sceneName: name });
  }
  async triggerTransition() {
    const sceneName = this.state.remotePreviewScene;
    if (!sceneName || sceneName === this.state.currentScene) {
      return;
    }

    await this.obs.call("SetCurrentProgramScene", { sceneName });
    this.update({ currentScene: sceneName });
    await this.refreshProgramMonitor();
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
}

export const obsClient = new ObsClient();
