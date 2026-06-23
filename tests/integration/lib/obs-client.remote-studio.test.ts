import assert from "node:assert/strict";
import test from "node:test";

import { ObsClient } from "../../../src/lib/obs-client.ts";
import type { SceneGuardMetrics } from "../../../src/lib/obs-scene-guard.ts";

type CallRecord = {
  method: string;
  args?: Record<string, unknown>;
};

type BatchRequest = {
  requestType: string;
  requestData?: Record<string, unknown>;
};

type BatchResponse = {
  requestType: string;
  requestStatus:
    | { result: true; code: number }
    | { result: false; code: number; comment: string };
  responseData: unknown;
};

type FakeObs = {
  calls: CallRecord[];
  responses: Map<string, unknown>;
  screenshotResponses: Map<string, unknown>;
  handlers: Map<string, (payload: any) => void>;
  inputList: Array<{
    inputName: string;
    inputKind: string;
    unversionedInputKind: string;
  }>;
  sceneItemsByScene: Map<
    string,
    Array<{
      sceneItemId: number;
      sourceName: string;
      sceneItemEnabled: boolean;
    }>
  >;
  sourceActivity: Map<string, { videoActive: boolean; videoShowing: boolean }>;
  statsQueue: Array<{
    cpuUsage: number;
    memoryUsage: number;
    availableDiskSpace: number;
    activeFps: number;
    averageFrameRenderTime: number;
    renderSkippedFrames: number;
    renderTotalFrames: number;
    outputSkippedFrames: number;
    outputTotalFrames: number;
  }>;
  onCall?: (method: string, args?: Record<string, unknown>) => void;
  call: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  callBatch: (requests: BatchRequest[]) => Promise<BatchResponse[]>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  trigger: (event: string, payload: unknown) => void;
};

function createStats(
  overrides: Partial<FakeObs["statsQueue"][number]> = {},
): FakeObs["statsQueue"][number] {
  return {
    cpuUsage: 12,
    memoryUsage: 450,
    availableDiskSpace: 1000,
    activeFps: 60,
    averageFrameRenderTime: 8,
    renderSkippedFrames: 0,
    renderTotalFrames: 1000,
    outputSkippedFrames: 0,
    outputTotalFrames: 1000,
    ...overrides,
  };
}

function createClient() {
  let now = 1_000;
  const analysisByImage = new Map<string, SceneGuardMetrics>([
    [
      "data:image/jpeg;base64,c2NlbmUtYQ==",
      {
        averageLuma: 80,
        blackPixelRatio: 0.04,
        averageSaturation: 0.2,
        centerBrightRatio: 0.25,
        transmitterScore: 0.05,
        rainbowBarScore: 0,
      },
    ],
    [
      "data:image/jpeg;base64,c2NlbmUtYg==",
      {
        averageLuma: 80,
        blackPixelRatio: 0.04,
        averageSaturation: 0.2,
        centerBrightRatio: 0.25,
        transmitterScore: 0.05,
        rainbowBarScore: 0,
      },
    ],
  ]);

  const client = new ObsClient({
    analyzeSceneGuardImageDataUrl: async (imageDataUrl) => {
      const metrics = analysisByImage.get(imageDataUrl);
      if (!metrics) {
        throw new Error(`No fake metrics for ${imageDataUrl}`);
      }
      return metrics;
    },
    now: () => now,
  });

  const fakeObs: FakeObs = {
    calls: [],
    responses: new Map<string, unknown>([
      [
        "GetSceneList",
        {
          scenes: [{ sceneName: "Scene A" }, { sceneName: "Scene B" }],
          currentProgramSceneName: "Scene A",
        },
      ],
      ["GetStreamStatus", { outputActive: false }],
      ["GetRecordStatus", { outputActive: false, outputPaused: false }],
      ["GetVirtualCamStatus", { outputActive: false }],
    ]),
    screenshotResponses: new Map<string, unknown>([
      ["Scene A", { imageData: "c2NlbmUtYQ==" }],
      ["Scene B", { imageData: "c2NlbmUtYg==" }],
      ["Scene A Camera", { imageData: "Y2FtLWE=" }],
      ["Scene B Browser", { imageData: "YnJvd3Nlci1i" }],
    ]),
    handlers: new Map(),
    inputList: [
      {
        inputName: "Scene A Camera",
        inputKind: "dshow_input",
        unversionedInputKind: "dshow_input",
      },
      {
        inputName: "Scene B Browser",
        inputKind: "browser_source",
        unversionedInputKind: "browser_source",
      },
    ],
    sceneItemsByScene: new Map([
      [
        "Scene A",
        [{ sceneItemId: 8, sourceName: "Scene A Camera", sceneItemEnabled: true }],
      ],
      [
        "Scene B",
        [{ sceneItemId: 11, sourceName: "Scene B Browser", sceneItemEnabled: true }],
      ],
    ]),
    sourceActivity: new Map([
      ["Scene A Camera", { videoActive: true, videoShowing: true }],
      ["Scene B Browser", { videoActive: true, videoShowing: true }],
    ]),
    statsQueue: [],
    async call(method, args) {
      this.onCall?.(method, args);
      this.calls.push({ method, args });

      if (method === "GetInputList") {
        return { inputs: this.inputList };
      }

      if (method === "GetSceneItemList") {
        return {
          sceneItems: this.sceneItemsByScene.get(String(args?.sceneName ?? "")) ?? [],
        };
      }

      if (method === "GetSourceActive") {
        return (
          this.sourceActivity.get(String(args?.sourceName ?? "")) ?? {
            videoActive: false,
            videoShowing: false,
          }
        );
      }

      if (method === "GetStats") {
        return this.statsQueue.shift() ?? createStats();
      }

      if (method === "GetSourceScreenshot") {
        const sourceName = String(args?.sourceName ?? "");
        const response = this.screenshotResponses.get(sourceName);
        if (response == null) {
          throw new Error(`No fake screenshot response for ${sourceName}`);
        }
        if (response instanceof Error) {
          throw response;
        }
        return response;
      }

      const response = this.responses.get(method);
      if (response instanceof Error) {
        throw response;
      }
      return response ?? {};
    },
    async callBatch(requests) {
      const results: BatchResponse[] = [];

      for (const request of requests) {
        try {
          const responseData = await this.call(
            request.requestType,
            request.requestData,
          );
          results.push({
            requestType: request.requestType,
            requestStatus: { result: true, code: 100 },
            responseData,
          });
        } catch (error) {
          results.push({
            requestType: request.requestType,
            requestStatus: {
              result: false,
              code: 500,
              comment:
                error instanceof Error ? error.message : "batch request failed",
            },
            responseData: {},
          });
        }
      }

      return results;
    },
    on(event, handler) {
      this.handlers.set(event, handler as (payload: any) => void);
    },
    off(event) {
      this.handlers.delete(event);
    },
    async connect() {},
    async disconnect() {},
    trigger(event, payload) {
      this.handlers.get(event)?.(payload);
    },
  };

  client.obs = fakeObs as never;
  client.state = {
    connected: true,
    currentScene: "Scene A",
    scenes: ["Scene A", "Scene B"],
    sceneGuardEnabled: true,
    streaming: false,
    recording: false,
    recordPaused: false,
    virtualCam: false,
    remoteStudioMode: false,
    remotePreviewScene: "Scene A",
    programMonitor: {
      imageDataUrl: null,
      loading: false,
      error: undefined,
      lastUpdatedAt: null,
    },
    sceneGuard: {},
    pendingProgramSwitch: null,
  } as never;

  return {
    client,
    fakeObs,
    analysisByImage,
    advanceTime: (ms: number) => {
      now += ms;
    },
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("remote studio toggle does not call OBS studio mode APIs", async () => {
  const { client, fakeObs } = createClient();

  client.toggleRemoteStudio();
  client.toggleRemoteStudio();

  assert.equal(client.state.remoteStudioMode, false);
  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetStudioModeEnabled"),
    [],
  );
});

test("setScene hard-cuts when remote studio is off", async () => {
  const { client, fakeObs } = createClient();

  await client.setScene("Scene B");

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
  assert.equal(client.state.remotePreviewScene, "Scene A");
});

test("setScene updates only local preview when remote studio is on", async () => {
  const { client, fakeObs } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");

  assert.equal(client.state.remotePreviewScene, "Scene B");
  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetCurrentProgramScene"),
    [],
  );
});

test("triggerTransition promotes local preview to OBS program", async () => {
  const { client, fakeObs } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");
  await client.triggerTransition();

  assert.deepEqual(
    [...fakeObs.calls]
      .reverse()
      .find((call) => call.method === "SetCurrentProgramScene"),
    {
      method: "SetCurrentProgramScene",
      args: { sceneName: "Scene B" },
    },
  );
});

test("refreshAll preserves local preview while remote studio is on", async () => {
  const { client } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");
  await client.refreshAll();

  assert.equal(client.state.currentScene, "Scene A");
  assert.equal(client.state.remotePreviewScene, "Scene B");
});

test("connect fetches the initial program monitor frame", async () => {
  const { client, fakeObs } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });

  assert.equal(
    fakeObs.calls.some((call) => call.method === "GetSourceScreenshot"),
    true,
  );
  assert.match(
    client.state.programMonitor.imageDataUrl ?? "",
    /^data:image\/jpeg;base64,/,
  );
  assert.equal(client.state.programMonitor.error, undefined);
  assert.equal(typeof client.state.programMonitor.lastUpdatedAt, "number");

  await client.disconnect();
});

test("program scene changes trigger an immediate monitor refresh", async () => {
  const { client, fakeObs } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });
  fakeObs.screenshotResponses.set("Scene B", { imageData: "bmV4dC1mcmFtZQ==" });

  fakeObs.trigger("CurrentProgramSceneChanged", { sceneName: "Scene B" });
  await flushAsyncWork();

  assert.deepEqual(
    [...fakeObs.calls]
      .reverse()
      .find(
        (call) =>
          call.method === "GetSourceScreenshot" &&
          call.args?.sourceName === "Scene B" &&
          call.args?.imageWidth === 960,
      ),
    {
      method: "GetSourceScreenshot",
      args: {
        sourceName: "Scene B",
        imageFormat: "jpeg",
        imageWidth: 960,
        imageCompressionQuality: 75,
      },
    },
  );
  assert.equal(client.state.currentScene, "Scene B");

  await client.disconnect();
});

test("failed monitor refresh preserves the last good frame", async () => {
  const { client, fakeObs } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });
  const firstFrame = client.state.programMonitor.imageDataUrl;

  fakeObs.screenshotResponses.set("Scene B", new Error("screenshot failed"));
  fakeObs.trigger("CurrentProgramSceneChanged", { sceneName: "Scene B" });
  await flushAsyncWork();

  assert.equal(client.state.programMonitor.imageDataUrl, firstFrame);
  assert.equal(client.state.programMonitor.error, "screenshot failed");
  assert.equal(client.state.programMonitor.loading, false);

  await client.disconnect();
});

test("disconnect clears the monitor state", async () => {
  const { client } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });
  await client.disconnect();

  assert.equal(client.state.programMonitor.imageDataUrl, null);
  assert.equal(client.state.programMonitor.lastUpdatedAt, null);
  assert.equal(client.state.programMonitor.loading, false);
});

test("refresh skips screenshot capture when there is no current scene", async () => {
  const { client, fakeObs } = createClient();

  client.state.currentScene = null;
  await client.connect({ url: "ws://127.0.0.1:4455" });
  fakeObs.calls.length = 0;
  client.state.currentScene = null;

  await (client as any).refreshProgramMonitor();

  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "GetSourceScreenshot"),
    [],
  );

  await client.disconnect();
});

test("refreshAll seeds new scene guard entries as unknown", async () => {
  const { client } = createClient();

  await client.refreshAll();

  assert.deepEqual(client.state.sceneGuard["Scene A"], {
    status: "unknown",
    reasons: [],
    image: {
      status: "unknown",
      reasons: [],
      lastCheckedAt: null,
    },
    sourceHealth: {
      status: "unknown",
      reasons: [],
      sourceName: null,
      sourceKind: null,
      lastCheckedAt: null,
      lastHealthyAt: null,
      lastProbeLatencyMs: null,
      consecutiveFailures: 0,
      consecutiveSlowProbes: 0,
    },
  });
});

test("a scene image pass marks a full-black scene as flagged", async () => {
  const { client, analysisByImage } = createClient();

  analysisByImage.set("data:image/jpeg;base64,c2NlbmUtYQ==", {
    averageLuma: 0,
    blackPixelRatio: 1,
    averageSaturation: 0,
    centerBrightRatio: 0,
    transmitterScore: 0.02,
    rainbowBarScore: 0,
  });

  await client.refreshAll();
  await (client as any).runSceneImagePass();

  assert.deepEqual(client.state.sceneGuard["Scene A"]?.image, {
    status: "flagged",
    reasons: ["fullBlack"],
    lastCheckedAt: 1_000,
  });
  assert.deepEqual(client.state.sceneGuard["Scene A"]?.reasons, ["fullBlack"]);
});

test("source-health pass resolves the primary capture source for Scene A", async () => {
  const { client } = createClient();

  await client.refreshAll();
  await (client as any).runSourceHealthPass();

  assert.equal(
    client.state.sceneGuard["Scene A"]?.sourceHealth.sourceName,
    "Scene A Camera",
  );
  assert.equal(
    client.state.sceneGuard["Scene A"]?.sourceHealth.sourceKind,
    "dshow_input",
  );
});

test("three failed source-health probes flag frozenSource", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  fakeObs.screenshotResponses.set("Scene A Camera", new Error("probe failed"));
  fakeObs.sourceActivity.set("Scene A Camera", {
    videoActive: false,
    videoShowing: false,
  });

  await client.refreshAll();
  await (client as any).runSourceHealthPass();
  advanceTime(50);
  await (client as any).runSourceHealthPass();
  advanceTime(50);
  await (client as any).runSourceHealthPass();

  assert.deepEqual(client.state.sceneGuard["Scene A"]?.sourceHealth.reasons, [
    "frozenSource",
  ]);
});

test("three slow source-health probes flag laggySource", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  fakeObs.onCall = (method) => {
    if (method === "GetSourceScreenshot") {
      advanceTime(160);
    }
  };

  await client.refreshAll();
  await (client as any).runSourceHealthPass();
  await (client as any).runSourceHealthPass();
  await (client as any).runSourceHealthPass();

  assert.deepEqual(client.state.sceneGuard["Scene A"]?.sourceHealth.reasons, [
    "laggySource",
  ]);
});

test("setScene stores a pending confirmation instead of hard-cutting a flagged source", async () => {
  const { client } = createClient();

  client.state.sceneGuard["Scene B"] = {
    status: "flagged",
    reasons: ["laggySource"],
    image: {
      status: "healthy",
      reasons: [],
      lastCheckedAt: 1_000,
    },
    sourceHealth: {
      status: "flagged",
      reasons: ["laggySource"],
      sourceName: "Scene B Browser",
      sourceKind: "browser_source",
      lastCheckedAt: 1_000,
      lastHealthyAt: 900,
      lastProbeLatencyMs: 180,
      consecutiveFailures: 0,
      consecutiveSlowProbes: 3,
    },
  } as never;

  await client.setScene("Scene B");

  assert.deepEqual(client.state.pendingProgramSwitch, {
    sceneName: "Scene B",
    reasons: ["laggySource"],
    requestedFrom: "directCut",
  });
});

test("stale source-health data degrades to unknown and does not block a switch", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  client.state.sceneGuard["Scene B"] = {
    status: "flagged",
    reasons: ["laggySource"],
    image: {
      status: "healthy",
      reasons: [],
      lastCheckedAt: 1_000,
    },
    sourceHealth: {
      status: "flagged",
      reasons: ["laggySource"],
      sourceName: "Scene B Browser",
      sourceKind: "browser_source",
      lastCheckedAt: 1_000,
      lastHealthyAt: 900,
      lastProbeLatencyMs: 190,
      consecutiveFailures: 0,
      consecutiveSlowProbes: 3,
    },
  } as never;
  advanceTime(300);

  await client.setScene("Scene B");

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
  assert.equal(client.state.pendingProgramSwitch, null);
});

test("disabled scene guard allows a flagged scene to switch immediately", async () => {
  const { client, fakeObs } = createClient();

  client.toggleSceneGuard();
  client.state.sceneGuard["Scene B"] = {
    status: "flagged",
    reasons: ["laggySource"],
    image: {
      status: "healthy",
      reasons: [],
      lastCheckedAt: 1_000,
    },
    sourceHealth: {
      status: "flagged",
      reasons: ["laggySource"],
      sourceName: "Scene B Browser",
      sourceKind: "browser_source",
      lastCheckedAt: 1_000,
      lastHealthyAt: 900,
      lastProbeLatencyMs: 180,
      consecutiveFailures: 0,
      consecutiveSlowProbes: 3,
    },
  } as never;

  await client.setScene("Scene B");

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
  assert.equal(client.state.pendingProgramSwitch, null);
});

test("confirmPendingProgramSwitch sends the deferred OBS switch", async () => {
  const { client, fakeObs } = createClient();

  client.state.pendingProgramSwitch = {
    sceneName: "Scene B",
    reasons: ["fullBlack"],
    requestedFrom: "directCut",
  } as never;

  await client.confirmPendingProgramSwitch();

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
  assert.equal(client.state.pendingProgramSwitch, null);
});

test("cancelPendingProgramSwitch clears the pending scene without switching", () => {
  const { client, fakeObs } = createClient();

  client.state.pendingProgramSwitch = {
    sceneName: "Scene B",
    reasons: ["possibleTransmitterFallback"],
    requestedFrom: "transition",
  } as never;

  client.cancelPendingProgramSwitch();

  assert.equal(client.state.pendingProgramSwitch, null);
  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetCurrentProgramScene"),
    [],
  );
});

test("triggerTransition opens confirmation when the staged preview is flagged", async () => {
  const { client } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");
  client.state.sceneGuard["Scene B"] = {
    status: "flagged",
    reasons: ["possibleTransmitterFallback"],
    image: {
      status: "flagged",
      reasons: ["possibleTransmitterFallback"],
      lastCheckedAt: 1_000,
    },
    sourceHealth: {
      status: "healthy",
      reasons: [],
      sourceName: "Scene B Browser",
      sourceKind: "browser_source",
      lastCheckedAt: 1_000,
      lastHealthyAt: 1_000,
      lastProbeLatencyMs: 30,
      consecutiveFailures: 0,
      consecutiveSlowProbes: 0,
    },
  } as never;

  await client.triggerTransition();

  assert.deepEqual(client.state.pendingProgramSwitch, {
    sceneName: "Scene B",
    reasons: ["possibleTransmitterFallback"],
    requestedFrom: "transition",
  });
});
