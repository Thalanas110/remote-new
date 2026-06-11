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
  call: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
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
    ]),
    async call(method, args) {
      this.calls.push({ method, args });
      return this.responses.get(method) ?? {};
    },
    on() {},
    off() {},
    async connect() {},
    async disconnect() {},
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
  } as never;

  return { client, fakeObs };
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

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
});

test("refreshAll preserves local preview while remote studio is on", async () => {
  const { client } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");
  await client.refreshAll();

  assert.equal(client.state.currentScene, "Scene A");
  assert.equal(client.state.remotePreviewScene, "Scene B");
});
