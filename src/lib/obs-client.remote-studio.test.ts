import assert from "node:assert/strict";
import test from "node:test";

import { ObsClient } from "./obs-client.ts";

type CallRecord = {
  method: string;
  args?: Record<string, unknown>;
};

type FakeObs = {
  calls: CallRecord[];
  responses: Map<string, unknown>;
  handlers: Map<string, (payload: any) => void>;
  call: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  trigger: (event: string, payload: unknown) => void;
};

function createClient() {
  const client = new ObsClient();
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
      ["GetSourceScreenshot", { imageData: "ZmFrZS1mcmFtZQ==" }],
    ]),
    handlers: new Map(),
    async call(method, args) {
      this.calls.push({ method, args });
      const response = this.responses.get(method);
      if (response instanceof Error) {
        throw response;
      }
      return response ?? {};
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
  } as never;

  return { client, fakeObs };
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
    [...fakeObs.calls].reverse().find((call) => call.method === "SetCurrentProgramScene"),
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
  fakeObs.responses.set("GetSourceScreenshot", { imageData: "bmV4dC1mcmFtZQ==" });

  fakeObs.trigger("CurrentProgramSceneChanged", { sceneName: "Scene B" });
  await flushAsyncWork();

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "GetSourceScreenshot",
    args: {
      sourceName: "Scene B",
      imageFormat: "jpeg",
      imageWidth: 960,
      imageCompressionQuality: 75,
    },
  });
  assert.equal(client.state.currentScene, "Scene B");

  await client.disconnect();
});

test("failed monitor refresh preserves the last good frame", async () => {
  const { client, fakeObs } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });
  const firstFrame = client.state.programMonitor.imageDataUrl;

  fakeObs.responses.set("GetSourceScreenshot", new Error("screenshot failed"));
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
