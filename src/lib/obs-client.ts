import OBSWebSocket from "obs-websocket-js";

export type ObsConfig = {
  url: string;
  password?: string;
};

export type ObsState = {
  connected: boolean;
  currentScene: string | null;
  scenes: string[];
  remoteStudioMode: boolean;
  remotePreviewScene: string | null;
  streaming: boolean;
  recording: boolean;
  recordPaused: boolean;
  virtualCam: boolean;
  error?: string;
};

export const defaultObsState: ObsState = {
  connected: false,
  currentScene: null,
  scenes: [],
  remoteStudioMode: false,
  remotePreviewScene: null,
  streaming: false,
  recording: false,
  recordPaused: false,
  virtualCam: false,
};

export class ObsClient {
  obs = new OBSWebSocket();
  private listeners = new Set<(s: ObsState) => void>();
  state: ObsState = { ...defaultObsState };

  subscribe(fn: (s: ObsState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<ObsState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  async connect(config: ObsConfig) {
    try {
      await this.obs.disconnect().catch(() => {});
      await this.obs.connect(config.url, config.password || undefined);
      this.bindEvents();
      await this.refreshAll();
      this.update({ connected: true, error: undefined });
    } catch (e: any) {
      this.update({ connected: false, error: e?.message ?? "Failed to connect" });
      throw e;
    }
  }

  async disconnect() {
    await this.obs.disconnect().catch(() => {});
    this.update({ ...defaultObsState });
  }

  private bindEvents() {
    this.obs.off("ConnectionClosed" as any);
    this.obs.on("ConnectionClosed", () => this.update({ connected: false }));
    this.obs.on("CurrentProgramSceneChanged", (d: any) =>
      this.update({
        currentScene: d.sceneName,
        remotePreviewScene: this.state.remoteStudioMode
          ? this.state.remotePreviewScene
          : d.sceneName,
      })
    );
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
