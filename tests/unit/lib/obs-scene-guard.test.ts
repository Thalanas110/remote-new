import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeSceneGuardPixels,
  classifySceneImageSample,
  composeSceneGuardState,
  createDefaultSceneImageGuardState,
  createDefaultSourceHealthGuardState,
  formatSceneGuardReason,
  isSceneImageFresh,
} from "../../../src/lib/obs-scene-guard.ts";

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

function createVerticalColorBarsPixels(width: number, height: number) {
  const bars: Array<[number, number, number]> = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
  ];
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const barIndex = Math.min(bars.length - 1, Math.floor((x / width) * bars.length));
      const rgb = bars[barIndex];
      const offset = (y * width + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

test("classifySceneImageSample flags a full-black frame", () => {
  const metrics = analyzeSceneGuardPixels({
    data: createSolidPixels(8, 8, [0, 0, 0]),
    width: 8,
    height: 8,
  });

  const next = classifySceneImageSample(createDefaultSceneImageGuardState(), metrics, 1_000);

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["fullBlack"]);
});

test("classifySceneImageSample surfaces rainbow no-signal bars as possibleTransmitterFallback", () => {
  const metrics = analyzeSceneGuardPixels({
    data: createVerticalColorBarsPixels(84, 48),
    width: 84,
    height: 48,
  });

  const next = classifySceneImageSample(createDefaultSceneImageGuardState(), metrics, 1_000);

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["possibleTransmitterFallback"]);
});

test("composeSceneGuardState merges image and source-health reasons", () => {
  const image = {
    status: "healthy" as const,
    reasons: [],
    lastCheckedAt: 1_000,
  };
  const sourceHealth = {
    ...createDefaultSourceHealthGuardState(),
    status: "flagged" as const,
    reasons: ["laggySource"] as const,
    sourceName: "Scene B Browser",
    sourceKind: "browser_source",
    lastCheckedAt: 1_000,
    lastHealthyAt: 900,
    lastProbeLatencyMs: 180,
    consecutiveFailures: 0,
    consecutiveSlowProbes: 3,
  };

  const next = composeSceneGuardState({ image, sourceHealth });

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["laggySource"]);
});

test("isSceneImageFresh rejects stale image checks", () => {
  assert.equal(
    isSceneImageFresh({ status: "healthy", reasons: [], lastCheckedAt: 1_000 }, 10_999),
    true,
  );
  assert.equal(
    isSceneImageFresh({ status: "healthy", reasons: [], lastCheckedAt: 1_000 }, 11_001),
    false,
  );
});

test("formatSceneGuardReason returns the new source-health labels", () => {
  assert.equal(formatSceneGuardReason("frozenSource"), "Frozen source");
  assert.equal(formatSceneGuardReason("laggySource"), "Laggy source");
});
