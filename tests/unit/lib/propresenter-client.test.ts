import assert from "node:assert/strict";
import test from "node:test";

import { PpClient } from "../../../src/lib/propresenter-client.ts";

type RequestCall = {
  baseUrl: string;
  path: string;
  method: "GET" | "POST" | "PUT";
  body?: unknown;
};

function createClient() {
  const calls: RequestCall[] = [];
  const client = new PpClient({
    request: async ({ baseUrl, path, method, body }) => {
      calls.push({ baseUrl, path, method, body });

      switch (`${method} ${path}`) {
        case "GET /version":
          return { name: "ProPresenter 7.18" };
        case "GET /v1/presentation/active":
          return {
            presentation: {
              name: "Sunday Service",
            },
          };
        case "GET /v1/presentation/slide_index":
          return {
            presentation_index: {
              index: 2,
            },
            slides: [{}, {}, {}, {}],
          };
        case "GET /v1/presentation/active/next/trigger":
        case "GET /v1/clear/layer/slide":
        case "GET /v1/clear/layer/audio":
        case "GET /v1/clear/layer/props":
        case "GET /v1/clear/layer/messages":
        case "GET /v1/clear/layer/announcements":
        case "GET /v1/clear/layer/media":
        case "GET /v1/clear/layer/video_input":
        case "GET /v1/trigger/media/next":
        case "GET /v1/timer/Service%20Timer/start":
          return null;
        case "GET /v1/status/audience_screens":
          return false;
        case "PUT /v1/status/audience_screens":
          assert.equal(body, true);
          return null;
        default:
          throw new Error(`Unhandled request: ${method} ${path}`);
      }
    },
    setIntervalFn: () => 1 as never,
    clearIntervalFn: () => {},
  });

  return { client, calls };
}

test("connect and refresh route through the configured request transport", async () => {
  const { client, calls } = createClient();

  await client.connect({ baseUrl: "http://pp.example:50001" });

  assert.equal(client.state.connected, true);
  assert.equal(client.state.version, "ProPresenter 7.18");
  assert.equal(client.state.activePresentationName, "Sunday Service");
  assert.equal(client.state.currentSlideIndex, 2);
  assert.equal(client.state.totalSlides, 4);
  assert.deepEqual(calls, [
    {
      baseUrl: "http://pp.example:50001",
      path: "/version",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/presentation/active",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/presentation/slide_index",
      method: "GET",
    },
  ]);
});

test("transport-backed actions reuse the configured base URL", async () => {
  const { client, calls } = createClient();

  client.config = { baseUrl: "http://pp.example:50001" };
  await client.next();

  assert.deepEqual(calls, [
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/presentation/active/next/trigger",
      method: "GET",
    },
  ]);
});

test("clearSlide uses the ProPresenter slide layer path", async () => {
  const { client, calls } = createClient();

  client.config = { baseUrl: "http://pp.example:50001" };
  await client.clearSlide();

  assert.deepEqual(calls, [
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/slide",
      method: "GET",
    },
  ]);
});

test("clearAll clears each supported layer with ProPresenter GET requests", async () => {
  const { client, calls } = createClient();

  client.config = { baseUrl: "http://pp.example:50001" };
  await client.clearAll();

  assert.deepEqual(calls, [
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/audio",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/props",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/messages",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/announcements",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/slide",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/media",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/clear/layer/video_input",
      method: "GET",
    },
  ]);
});

test("timer operations use GET against the timer operation endpoint", async () => {
  const { client, calls } = createClient();

  client.config = { baseUrl: "http://pp.example:50001" };
  await client.timerStart("Service Timer");

  assert.deepEqual(calls, [
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/timer/Service%20Timer/start",
      method: "GET",
    },
  ]);
});

test("toggleLogo uses the media trigger endpoint with a GET request", async () => {
  const { client, calls } = createClient();

  client.config = { baseUrl: "http://pp.example:50001" };
  await client.toggleLogo();

  assert.deepEqual(calls, [
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/trigger/media/next",
      method: "GET",
    },
  ]);
});

test("audienceScreenToggle flips the current audience screen status with PUT", async () => {
  const { client, calls } = createClient();

  client.config = { baseUrl: "http://pp.example:50001" };
  await client.audienceScreenToggle();

  assert.deepEqual(calls, [
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/status/audience_screens",
      method: "GET",
    },
    {
      baseUrl: "http://pp.example:50001",
      path: "/v1/status/audience_screens",
      method: "PUT",
      body: true,
    },
  ]);
});
