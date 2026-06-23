import OBSWebSocket, { EventSubscription, RequestBatchExecutionType } from "obs-websocket-js";
import type { SceneGuardMetrics, SceneGuardReason, SceneGuardState } from "./obs-scene-guard.ts";
import {
  SCENE_GUARD_ANALYSIS_FORMAT,
  SCENE_GUARD_ANALYSIS_QUALITY,
  SCENE_GUARD_ANALYSIS_WIDTH,
  classifySceneImageSample,
  composeSceneGuardState,
  createDefaultSceneGuardState,
  createDefaultSceneImageGuardState,
  createDefaultSourceHealthGuardState,
  isSceneImageFresh,
} from "./obs-scene-guard.ts";
import { analyzeSceneGuardImageDataUrl } from "./obs-scene-guard.browser.ts";
import {
  applySourceHealthProbe,
  isSourceHealthFresh,
  pickPrimarySceneSource,
  type ScenePrimarySource,
} from "./obs-source-health.ts";

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

type ObsInputCatalogEntry = {
  inputKind: string;
  unversionedInputKind: string | null;
};

type ObsSourceTelemetry = {
  videoActive: boolean | null;
  videoShowing: boolean | null;
  updatedAt: number | null;
};

type ObsSceneListResponse = {
  scenes: Array<{ sceneName: string }>;
  currentProgramSceneName: string | null;
};

type ObsInputListResponse = {
  inputs: Array<{
    inputName: string;
    inputKind: string;
    unversionedInputKind?: string | null;
  }>;
};

type ObsSceneItemListResponse = {
  sceneItems: Array<{
    sceneItemId?: number;
    sourceName?: string;
    sceneItemEnabled?: boolean;
  }>;
};

type ObsOutputStateResponse = {
  outputActive: boolean;
  outputPaused?: boolean;
  outputState?: string;
};

type ObsSourceScreenshotResponse = {
  imageData: string;
};

type ObsSourceActiveResponse = {
  videoActive?: boolean;
  videoShowing?: boolean;
};

type ObsStatsResponse = {
  averageFrameRenderTime?: number;
  renderSkippedFrames?: number;
};

type ObsCurrentProgramSceneChangedEvent = {
  sceneName: string;
};

type ObsSceneListChangedEvent = {
  scenes: Array<{ sceneName: string }>;
};

type ObsInputActiveStateChangedEvent = {
  inputName: string;
  videoActive: boolean;
};

type ObsInputShowStateChangedEvent = {
  inputName: string;
  videoShowing: boolean;
};

type ObsBatchResponse<T = unknown> = {
  requestStatus: {
    result: boolean;
  };
  responseData: T;
};

const OBS_CLIENT_EVENTS = [
  "ConnectionClosed",
  "CurrentProgramSceneChanged",
  "SceneListChanged",
  "InputActiveStateChanged",
  "InputShowStateChanged",
  "StreamStateChanged",
  "RecordStateChanged",
  "VirtualcamStateChanged",
] as const;

const PROGRAM_MONITOR_WIDTH = 960;
const PROGRAM_MONITOR_INTERVAL_MS = 1500;
const SOURCE_HEALTH_PROBE_WIDTH = 32;
const SOURCE_HEALTH_PROBE_QUALITY = 20;
const SOURCE_HEALTH_LOOP_DELAY_MS = 25;

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

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export const defaultObsState: ObsState = createDefaultObsState();

export class ObsClient {
  obs = new OBSWebSocket();
  private listeners = new Set<(s: ObsState) => void>();
  private programMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorRefreshInFlight: Promise<void> | null = null;
  private sceneImageTimer: ReturnType<typeof setTimeout> | null = null;
  private sceneImagePassInFlight: Promise<void> | null = null;
  private sourceHealthTimer: ReturnType<typeof setTimeout> | null = null;
  private sourceHealthPassInFlight: Promise<void> | null = null;
  private guardLoopsEnabled = false;
  private nextSceneImageIndex = 0;
  private nextSourceHealthIndex = 0;
  private inputCatalog: Record<string, ObsInputCatalogEntry> = {};
  private scenePrimarySources: Record<string, ScenePrimarySource> = {};
  private sourceTelemetry: Record<string, ObsSourceTelemetry> = {};
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
    this.listeners.forEach((listener) => listener(this.state));
  }

  private updateProgramMonitor(patch: Partial<ObsProgramMonitorState>) {
    this.update({
      programMonitor: {
        ...this.state.programMonitor,
        ...patch,
      },
    });
  }

  private setNextSceneIndices(sceneNames: string[], prioritySceneName: string | null) {
    if (sceneNames.length === 0) {
      this.nextSceneImageIndex = 0;
      this.nextSourceHealthIndex = 0;
      return;
    }

    const priorityIndex = prioritySceneName == null ? -1 : sceneNames.indexOf(prioritySceneName);
    const nextIndex =
      priorityIndex >= 0
        ? priorityIndex
        : Math.min(this.nextSceneImageIndex, sceneNames.length - 1);

    this.nextSceneImageIndex = nextIndex;
    this.nextSourceHealthIndex = nextIndex;
  }

  private reconcileSceneGuard(
    sceneNames: string[],
    prioritySceneName: string | null = this.state.currentScene,
  ) {
    const nextSceneGuard: Record<string, SceneGuardState> = {};
    const nextPrimarySources: Record<string, ScenePrimarySource> = {};

    for (const sceneName of sceneNames) {
      nextSceneGuard[sceneName] =
        this.state.sceneGuard[sceneName] ?? createDefaultSceneGuardState();
      if (this.scenePrimarySources[sceneName]) {
        nextPrimarySources[sceneName] = this.scenePrimarySources[sceneName];
      }
    }

    this.scenePrimarySources = nextPrimarySources;
    this.setNextSceneIndices(sceneNames, prioritySceneName);

    this.update({
      scenes: sceneNames,
      sceneGuard: nextSceneGuard,
    });
  }

  private async refreshInputCatalog() {
    const { inputs } = (await this.obs.call("GetInputList")) as ObsInputListResponse;
    this.inputCatalog = Object.fromEntries(
      inputs.map((input) => [
        String(input.inputName),
        {
          inputKind: String(input.inputKind),
          unversionedInputKind:
            input.unversionedInputKind == null ? null : String(input.unversionedInputKind),
        },
      ]),
    );
  }

  private updateSourceTelemetry(sourceName: string, patch: Partial<ObsSourceTelemetry>) {
    this.sourceTelemetry[sourceName] = {
      videoActive: this.sourceTelemetry[sourceName]?.videoActive ?? null,
      videoShowing: this.sourceTelemetry[sourceName]?.videoShowing ?? null,
      updatedAt: this.sourceTelemetry[sourceName]?.updatedAt ?? null,
      ...patch,
    };
  }

  private async resolvePrimarySource(sceneName: string) {
    const { sceneItems } = (await this.obs.call("GetSceneItemList", {
      sceneName,
    })) as ObsSceneItemListResponse;
    const primary = pickPrimarySceneSource(sceneItems, this.inputCatalog);
    this.scenePrimarySources[sceneName] = primary;
    return primary;
  }

  private updateSceneGuard(
    sceneName: string,
    patch: Partial<Pick<SceneGuardState, "image" | "sourceHealth">>,
  ) {
    const previous = this.state.sceneGuard[sceneName] ?? createDefaultSceneGuardState();
    const image = patch.image ?? previous.image;
    const sourceHealth = patch.sourceHealth ?? previous.sourceHealth;

    this.update({
      sceneGuard: {
        ...this.state.sceneGuard,
        [sceneName]: composeSceneGuardState({ image, sourceHealth }),
      },
    });
  }

  async connect(config: ObsConfig) {
    try {
      this.stopProgramMonitorPolling();
      this.stopGuardLoops();
      await this.obs.disconnect().catch(() => {});
      await this.obs.connect(config.url, config.password || undefined, {
        eventSubscriptions:
          EventSubscription.All |
          EventSubscription.InputActiveStateChanged |
          EventSubscription.InputShowStateChanged,
      });
      this.bindEvents();
      await this.refreshAll();
      this.update({ connected: true, error: undefined });
      await this.refreshProgramMonitor();
      this.startProgramMonitorPolling();
      this.guardLoopsEnabled = true;
      this.scheduleSceneImagePass();
      this.scheduleSourceHealthPass();
    } catch (error: unknown) {
      this.stopProgramMonitorPolling();
      this.stopGuardLoops();
      this.monitorRefreshInFlight = null;
      this.sceneImagePassInFlight = null;
      this.sourceHealthPassInFlight = null;
      this.guardLoopsEnabled = false;
      this.update({
        connected: false,
        error: getErrorMessage(error, "Failed to connect"),
        programMonitor: createDefaultProgramMonitorState(),
        sceneGuard: {},
        pendingProgramSwitch: null,
      });
      throw error;
    }
  }

  async disconnect() {
    this.stopProgramMonitorPolling();
    this.stopGuardLoops();
    this.monitorRefreshInFlight = null;
    this.sceneImagePassInFlight = null;
    this.sourceHealthPassInFlight = null;
    this.guardLoopsEnabled = false;
    await this.obs.disconnect().catch(() => {});
    this.update(createDefaultObsState());
  }

  private bindEvents() {
    for (const eventName of OBS_CLIENT_EVENTS) {
      this.obs.off(eventName);
    }

    this.obs.on("ConnectionClosed", () => {
      this.stopProgramMonitorPolling();
      this.stopGuardLoops();
      this.monitorRefreshInFlight = null;
      this.sceneImagePassInFlight = null;
      this.sourceHealthPassInFlight = null;
      this.guardLoopsEnabled = false;
      this.update({
        connected: false,
        programMonitor: createDefaultProgramMonitorState(),
        sceneGuard: {},
        pendingProgramSwitch: null,
      });
    });

    this.obs.on("CurrentProgramSceneChanged", (payload: ObsCurrentProgramSceneChangedEvent) => {
      this.update({
        currentScene: payload.sceneName,
        remotePreviewScene: this.state.remoteStudioMode
          ? this.state.remotePreviewScene
          : payload.sceneName,
      });
      this.setNextSceneIndices(this.state.scenes, payload.sceneName);
      this.scheduleSceneImagePass();
      this.scheduleSourceHealthPass();
      void this.refreshProgramMonitor();
    });

    this.obs.on("SceneListChanged", (payload: ObsSceneListChangedEvent) => {
      this.reconcileSceneGuard(
        payload.scenes.map((scene) => scene.sceneName).reverse(),
        this.state.currentScene,
      );
      this.scheduleSceneImagePass();
      this.scheduleSourceHealthPass();
    });

    this.obs.on("InputActiveStateChanged", (payload: ObsInputActiveStateChangedEvent) => {
      this.updateSourceTelemetry(String(payload.inputName), {
        videoActive: Boolean(payload.videoActive),
        updatedAt: this.now(),
      });
    });

    this.obs.on("InputShowStateChanged", (payload: ObsInputShowStateChangedEvent) => {
      this.updateSourceTelemetry(String(payload.inputName), {
        videoShowing: Boolean(payload.videoShowing),
        updatedAt: this.now(),
      });
    });

    this.obs.on("StreamStateChanged", (payload: ObsOutputStateResponse) =>
      this.update({ streaming: payload.outputActive }),
    );
    this.obs.on("RecordStateChanged", (payload: ObsOutputStateResponse) =>
      this.update({
        recording: payload.outputActive,
        recordPaused:
          payload.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED" || payload.outputPaused === true,
      }),
    );
    this.obs.on("VirtualcamStateChanged", (payload: ObsOutputStateResponse) =>
      this.update({ virtualCam: payload.outputActive }),
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

  private stopSceneImageLoop() {
    if (!this.sceneImageTimer) {
      return;
    }

    clearTimeout(this.sceneImageTimer);
    this.sceneImageTimer = null;
  }

  private stopSourceHealthLoop() {
    if (!this.sourceHealthTimer) {
      return;
    }

    clearTimeout(this.sourceHealthTimer);
    this.sourceHealthTimer = null;
  }

  private stopGuardLoops() {
    this.stopSceneImageLoop();
    this.stopSourceHealthLoop();
  }

  private scheduleSceneImagePass() {
    if (
      this.sceneImageTimer ||
      !this.guardLoopsEnabled ||
      !this.state.connected ||
      this.state.scenes.length === 0
    ) {
      return;
    }

    this.sceneImageTimer = setTimeout(() => {
      this.sceneImageTimer = null;
      void this.runSceneImagePass();
    }, 0);
    this.sceneImageTimer.unref?.();
  }

  private scheduleSourceHealthPass() {
    if (
      this.sourceHealthTimer ||
      !this.guardLoopsEnabled ||
      !this.state.connected ||
      this.state.scenes.length === 0
    ) {
      return;
    }

    this.sourceHealthTimer = setTimeout(() => {
      this.sourceHealthTimer = null;
      void this.runSourceHealthPass();
    }, SOURCE_HEALTH_LOOP_DELAY_MS);
    this.sourceHealthTimer.unref?.();
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
        const result = (await this.obs.call("GetSourceScreenshot", {
          sourceName: sceneName,
          imageFormat: "jpeg",
          imageWidth: PROGRAM_MONITOR_WIDTH,
          imageCompressionQuality: 75,
        })) as ObsSourceScreenshotResponse;

        this.updateProgramMonitor({
          imageDataUrl: toScreenshotDataUrl(result.imageData, "jpeg"),
          loading: false,
          error: undefined,
          lastUpdatedAt: Date.now(),
        });
      } catch (error: unknown) {
        this.updateProgramMonitor({
          loading: false,
          error: getErrorMessage(error, "Monitor refresh failed"),
        });
      } finally {
        this.monitorRefreshInFlight = null;
      }
    })();

    return this.monitorRefreshInFlight;
  }

  private async runSceneImagePass() {
    if (!this.state.connected || this.state.scenes.length === 0) {
      return;
    }

    if (this.sceneImagePassInFlight) {
      return this.sceneImagePassInFlight;
    }

    const sceneName = this.state.scenes[this.nextSceneImageIndex];

    this.sceneImagePassInFlight = (async () => {
      try {
        const screenshot = (await this.obs.call("GetSourceScreenshot", {
          sourceName: sceneName,
          imageFormat: SCENE_GUARD_ANALYSIS_FORMAT,
          imageWidth: SCENE_GUARD_ANALYSIS_WIDTH,
          imageCompressionQuality: SCENE_GUARD_ANALYSIS_QUALITY,
        })) as ObsSourceScreenshotResponse;

        const imageDataUrl = toScreenshotDataUrl(screenshot.imageData, SCENE_GUARD_ANALYSIS_FORMAT);
        const metrics = await this.analyzeSceneGuardImageDataUrl(imageDataUrl);
        const previous =
          this.state.sceneGuard[sceneName]?.image ?? createDefaultSceneImageGuardState();

        this.updateSceneGuard(sceneName, {
          image: classifySceneImageSample(previous, metrics, this.now()),
        });
      } catch {
        this.updateSceneGuard(sceneName, {
          image: createDefaultSceneImageGuardState(),
        });
      } finally {
        this.sceneImagePassInFlight = null;
        this.nextSceneImageIndex =
          this.state.scenes.length === 0
            ? 0
            : (this.nextSceneImageIndex + 1) % this.state.scenes.length;
        if (this.guardLoopsEnabled) {
          this.scheduleSceneImagePass();
        }
      }
    })();

    return this.sceneImagePassInFlight;
  }

  private async runSourceHealthPass() {
    if (!this.state.connected || this.state.scenes.length === 0) {
      return;
    }

    if (this.sourceHealthPassInFlight) {
      return this.sourceHealthPassInFlight;
    }

    const sceneName = this.state.scenes[this.nextSourceHealthIndex];

    this.sourceHealthPassInFlight = (async () => {
      try {
        const previous =
          this.state.sceneGuard[sceneName]?.sourceHealth ?? createDefaultSourceHealthGuardState();
        const primary =
          this.scenePrimarySources[sceneName] ?? (await this.resolvePrimarySource(sceneName));

        if (!primary.sourceName || !primary.sourceKind) {
          this.updateSceneGuard(sceneName, {
            sourceHealth: {
              ...createDefaultSourceHealthGuardState(),
              lastCheckedAt: this.now(),
            },
          });
          return;
        }

        const startedAt = this.now();
        const results = (await this.obs.callBatch(
          [
            { requestType: "GetStats" },
            {
              requestType: "GetSourceActive",
              requestData: { sourceName: primary.sourceName },
            },
            {
              requestType: "GetSourceScreenshot",
              requestData: {
                sourceName: primary.sourceName,
                imageFormat: "jpeg",
                imageWidth: SOURCE_HEALTH_PROBE_WIDTH,
                imageCompressionQuality: SOURCE_HEALTH_PROBE_QUALITY,
              },
            },
            { requestType: "GetStats" },
          ],
          {
            executionType: RequestBatchExecutionType.SerialRealtime,
            haltOnFailure: false,
          },
        )) as [
          ObsBatchResponse<ObsStatsResponse>,
          ObsBatchResponse<ObsSourceActiveResponse>,
          ObsBatchResponse<ObsSourceScreenshotResponse>,
          ObsBatchResponse<ObsStatsResponse>,
        ];

        const [beforeStats, active, screenshot, afterStats] = results;
        const telemetry = this.sourceTelemetry[primary.sourceName] ?? {
          videoActive: null,
          videoShowing: null,
          updatedAt: null,
        };

        if (active?.requestStatus?.result) {
          this.updateSourceTelemetry(primary.sourceName, {
            videoActive: Boolean(active.responseData?.videoActive),
            videoShowing: Boolean(active.responseData?.videoShowing),
            updatedAt: this.now(),
          });
        }

        this.updateSceneGuard(sceneName, {
          sourceHealth: applySourceHealthProbe(previous, primary, {
            checkedAt: this.now(),
            latencyMs: this.now() - startedAt,
            probeOk: Boolean(screenshot?.requestStatus?.result),
            sourceActive: active?.requestStatus?.result
              ? Boolean(active.responseData?.videoActive)
              : telemetry.videoActive,
            sourceShowing: active?.requestStatus?.result
              ? Boolean(active.responseData?.videoShowing)
              : telemetry.videoShowing,
            renderSkippedFramesDelta:
              beforeStats?.requestStatus?.result && afterStats?.requestStatus?.result
                ? Number(afterStats.responseData?.renderSkippedFrames) -
                  Number(beforeStats.responseData?.renderSkippedFrames)
                : 0,
            averageFrameRenderTimeMs: afterStats?.requestStatus?.result
              ? Number(afterStats.responseData?.averageFrameRenderTime)
              : 0,
          }),
        });
      } finally {
        this.sourceHealthPassInFlight = null;
        this.nextSourceHealthIndex =
          this.state.scenes.length === 0
            ? 0
            : (this.nextSourceHealthIndex + 1) % this.state.scenes.length;
        if (this.guardLoopsEnabled) {
          this.scheduleSourceHealthPass();
        }
      }
    })();

    return this.sourceHealthPassInFlight;
  }

  private getEffectiveSceneGuard(sceneName: string) {
    const sceneGuard = this.state.sceneGuard[sceneName];
    if (!sceneGuard) {
      return null;
    }

    const image = isSceneImageFresh(sceneGuard.image, this.now())
      ? sceneGuard.image
      : createDefaultSceneImageGuardState();
    const sourceHealth = isSourceHealthFresh(sceneGuard.sourceHealth, this.now())
      ? sceneGuard.sourceHealth
      : {
          ...sceneGuard.sourceHealth,
          status: "unknown" as const,
          reasons: [],
        };

    return composeSceneGuardState({ image, sourceHealth });
  }

  private async sendProgramScene(
    sceneName: string,
    requestedFrom: PendingProgramSwitch["requestedFrom"],
  ) {
    await this.obs.call("SetCurrentProgramScene", { sceneName });

    if (requestedFrom === "transition") {
      this.update({ currentScene: sceneName });
      this.setNextSceneIndices(this.state.scenes, sceneName);
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

    const sceneGuard = this.getEffectiveSceneGuard(sceneName);

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
    const sceneList = (await this.obs.call("GetSceneList")) as ObsSceneListResponse;
    const stream = (await this.obs.call("GetStreamStatus")) as ObsOutputStateResponse;
    const record = (await this.obs.call("GetRecordStatus")) as ObsOutputStateResponse;
    let virtualCam = false;
    try {
      const status = (await this.obs.call("GetVirtualCamStatus")) as ObsOutputStateResponse;
      virtualCam = status.outputActive;
    } catch {
      virtualCam = false;
    }

    await this.refreshInputCatalog();

    const scenes = sceneList.scenes.map((scene) => scene.sceneName).reverse();
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
      virtualCam,
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
        ? (this.state.remotePreviewScene ?? this.state.currentScene)
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
