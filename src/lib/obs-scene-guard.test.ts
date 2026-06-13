import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySceneGuardSample,
  createDefaultSceneGuardState,
  formatSceneGuardReason,
  isSceneGuardFresh,
  analyzeSceneGuardPixels,
} from "./obs-scene-guard.ts";

function createSolidPixels(width: number, height: number, rgb: [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    pixels[offset] = rgb[0];
    pixels[offset + 1] = rgb[1];
    pixels[offset + 2] = rgb[2];
    pixels[offset + 3] = 255;
  }

  return pixels;
}

test("analyzeSceneGuardPixels reports a full-black frame", () => {
  const metrics = analyzeSceneGuardPixels({
    data: createSolidPixels(8, 8, [0, 0, 0]),
    width: 8,
    height: 8,
  });

  assert.equal(metrics.averageLuma, 0);
  assert.equal(metrics.blackPixelRatio, 1);

  const next = classifySceneGuardSample(
    createDefaultSceneGuardState(),
    metrics,
    1_000,
  );

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["fullBlack"]);
});

test("classifySceneGuardSample flags frozen after three unchanged fingerprints", () => {
  const metrics = {
    averageLuma: 72,
    blackPixelRatio: 0.02,
    fingerprint: "0101010111001100",
    transmitterScore: 0.12,
  };

  const first = classifySceneGuardSample(createDefaultSceneGuardState(), metrics, 1_000);
  const second = classifySceneGuardSample(first, metrics, 2_000);
  const third = classifySceneGuardSample(second, metrics, 3_000);

  assert.equal(first.status, "healthy");
  assert.equal(second.status, "healthy");
  assert.equal(third.status, "flagged");
  assert.deepEqual(third.reasons, ["frozen"]);
});

test("classifySceneGuardSample flags possible transmitter fallback from a strong heuristic score", () => {
  const next = classifySceneGuardSample(
    createDefaultSceneGuardState(),
    {
      averageLuma: 118,
      blackPixelRatio: 0.08,
      fingerprint: "1111000011110000",
      transmitterScore: 0.92,
    },
    1_000,
  );

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["possibleTransmitterFallback"]);
});

test("isSceneGuardFresh rejects stale guard data", () => {
  const stale = {
    ...createDefaultSceneGuardState(),
    status: "healthy" as const,
    lastCheckedAt: 1_000,
  };

  assert.equal(isSceneGuardFresh(stale, 11_000), true);
  assert.equal(isSceneGuardFresh(stale, 11_001), false);
});

test("formatSceneGuardReason returns operator-facing labels", () => {
  assert.equal(formatSceneGuardReason("fullBlack"), "Full black");
  assert.equal(formatSceneGuardReason("frozen"), "Frozen");
  assert.equal(
    formatSceneGuardReason("possibleTransmitterFallback"),
    "Possible transmitter fallback screen",
  );
});
