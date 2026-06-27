import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEARABLE_LAYERS,
  buildClearLayerPath,
  buildTimerPath,
  normalizeProPresenterBaseUrl,
  parseActivePresentation,
  parseSlideIndex,
  parseVersion,
} from "../../../src/lib/propresenter-contract.ts";
import { proPresenterRequestSchema } from "../../../src/lib/propresenter-request.ts";

test("parseVersion maps documented host fields", () => {
  assert.deepEqual(
    parseVersion({
      name: "Sanctuary Mac",
      platform: "mac",
      os_version: "15.5",
      host_description: "ProPresenter 7.18.1",
      api_version: "v1",
    }),
    {
      machineName: "Sanctuary Mac",
      hostDescription: "ProPresenter 7.18.1",
      apiVersion: "v1",
    },
  );
});

test("parseActivePresentation reads presentation.id.name and grouped slides", () => {
  assert.deepEqual(
    parseActivePresentation({
      presentation: {
        id: { uuid: "presentation-1", name: "Sunday Service", index: 2 },
        groups: [
          { name: "Verse", color: "#fff", slides: [{}, {}] },
          { name: "Chorus", color: "#fff", slides: [{}, {}, {}] },
        ],
      },
    }),
    { activePresentationName: "Sunday Service", totalSlides: 5 },
  );
});

test("parseActivePresentation represents no active presentation", () => {
  assert.deepEqual(parseActivePresentation({}), {
    activePresentationName: undefined,
    totalSlides: undefined,
  });
});

test("parseActivePresentation rejects malformed non-empty data", () => {
  assert.throws(
    () => parseActivePresentation({ presentation: { name: "Wrong shape" } }),
    /active presentation/i,
  );
});

test("parseSlideIndex maps the documented presentation_index field", () => {
  assert.equal(
    parseSlideIndex({
      presentation_index: {
        index: 2,
        presentation_id: { uuid: "presentation-1", name: "Sunday Service", index: 0 },
      },
    }),
    2,
  );
});

test("endpoint builders encode only documented values", () => {
  assert.deepEqual(CLEARABLE_LAYERS, [
    "audio",
    "props",
    "messages",
    "announcements",
    "slide",
    "media",
    "video_input",
  ]);
  assert.equal(buildClearLayerPath("slide"), "/v1/clear/layer/slide");
  assert.equal(buildTimerPath("Service Timer", "start"), "/v1/timer/Service%20Timer/start");
});

test("normalizeProPresenterBaseUrl accepts HTTP URLs and removes trailing slashes", () => {
  assert.equal(
    normalizeProPresenterBaseUrl(" http://192.168.1.20:50001/// "),
    "http://192.168.1.20:50001",
  );
  assert.throws(() => normalizeProPresenterBaseUrl("ws://localhost:50001"), /HTTP/i);
});

test("request schema accepts only supported method and path pairs", () => {
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "GET",
      path: "/v1/presentation/active/next/trigger",
    }).success,
    true,
  );
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "PUT",
      path: "/v1/status/audience_screens",
      body: true,
    }).success,
    true,
  );
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "POST",
      path: "/v1/presentation/active/next/trigger",
    }).success,
    false,
  );
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "GET",
      path: "/admin/not-propresenter",
    }).success,
    false,
  );
});
