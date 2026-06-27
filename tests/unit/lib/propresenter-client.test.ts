import assert from "node:assert/strict";
import test from "node:test";

import { PpClient, type PpTransportRequest } from "../../../src/lib/propresenter-client.ts";

const version = {
  name: "Sanctuary Mac",
  platform: "mac",
  os_version: "15.5",
  host_description: "ProPresenter 7.18.1",
  api_version: "v1",
};
const active = {
  presentation: {
    id: { uuid: "p1", name: "Sunday Service", index: 0 },
    groups: [{ name: "Main", color: "#fff", slides: [{}, {}, {}, {}] }],
  },
};
const slideIndex = {
  presentation_index: { index: 2, presentation_id: { uuid: "p1" } },
};

function createHarness() {
  const calls: PpTransportRequest[] = [];
  const responses = new Map<string, unknown>([
    ["GET /version", version],
    ["GET /v1/presentation/active", active],
    ["GET /v1/presentation/slide_index", slideIndex],
  ]);
  let intervalCallback: (() => void) | undefined;
  const cleared: unknown[] = [];
  const client = new PpClient({
    request: async (request) => {
      calls.push(request);
      const key = `${request.method} ${request.path}`;
      const response = responses.get(key);
      if (response instanceof Error) throw response;
      if (!responses.has(key)) throw new Error(`Unhandled request: ${key}`);
      return response;
    },
    setIntervalFn: ((callback: () => void) => {
      intervalCallback = callback;
      return 41 as never;
    }) as typeof globalThis.setInterval,
    clearIntervalFn: ((id: unknown) => cleared.push(id)) as typeof globalThis.clearInterval,
  });
  return { client, calls, responses, cleared, runPoll: () => intervalCallback?.() };
}

test("connect maps official host and presentation state", async () => {
  const { client, calls } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001/" });
  assert.deepEqual(client.state, {
    connected: true,
    degraded: false,
    machineName: "Sanctuary Mac",
    hostDescription: "ProPresenter 7.18.1",
    apiVersion: "v1",
    activePresentationName: "Sunday Service",
    currentSlideIndex: 2,
    totalSlides: 4,
  });
  assert.equal(calls[0].baseUrl, "http://pp.example:50001");
});

test("a failed refresh preserves the last snapshot and marks degraded", async () => {
  const { client, responses } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001" });
  responses.set("GET /v1/presentation/active", new Error("connection refused"));
  await client.refresh();
  assert.equal(client.state.degraded, true);
  assert.equal(client.state.connected, true);
  assert.equal(client.state.activePresentationName, "Sunday Service");
  assert.match(client.state.refreshError ?? "", /connection refused/);
});

test("three failed refreshes mark offline and a success recovers", async () => {
  const { client, responses } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001" });
  responses.set("GET /v1/presentation/active", new Error("offline"));
  await client.refresh();
  await client.refresh();
  await client.refresh();
  assert.equal(client.state.connected, false);
  responses.set("GET /v1/presentation/active", active);
  await client.refresh();
  assert.equal(client.state.connected, true);
  assert.equal(client.state.degraded, false);
});

test("overlapping refresh calls share one in-flight request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let activeCalls = 0;
  const client = new PpClient({
    request: async (request) => {
      if (request.path === "/version") return version;
      if (request.path === "/v1/presentation/active") {
        activeCalls += 1;
        await gate;
        return active;
      }
      return slideIndex;
    },
    setIntervalFn: (() => 1 as never) as typeof globalThis.setInterval,
    clearIntervalFn: (() => {}) as typeof globalThis.clearInterval,
  });
  client.config = { baseUrl: "http://pp.example:50001" };
  const first = client.refresh();
  const second = client.refresh();
  release();
  await Promise.all([first, second]);
  assert.equal(activeCalls, 1);
});

test("disconnect clears polling and resets state", async () => {
  const { client, cleared } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001" });
  client.disconnect();
  assert.deepEqual(cleared, [41]);
  assert.deepEqual(client.state, { connected: false, degraded: false });
});

test("a refresh that resolves after disconnect cannot restore stale state", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const client = new PpClient({
    request: async (request) => {
      if (request.path === "/v1/presentation/active") {
        await gate;
        return active;
      }
      return slideIndex;
    },
    setIntervalFn: (() => 1 as never) as typeof globalThis.setInterval,
    clearIntervalFn: (() => {}) as typeof globalThis.clearInterval,
  });
  client.config = { baseUrl: "http://pp.example:50001" };
  const refresh = client.refresh();
  client.disconnect();
  release();
  await refresh;
  assert.deepEqual(client.state, { connected: false, degraded: false });
});
