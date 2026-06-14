import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySceneGuardSample,
  createDefaultSceneGuardState,
  formatSceneGuardReason,
  isSceneGuardFresh,
  analyzeSceneGuardPixels,
} from "./obs-scene-guard.ts";

function createMetrics(
  overrides: Partial<ReturnType<typeof analyzeSceneGuardPixels>> = {},
) {
  return {
    averageLuma: 80,
    blackPixelRatio: 0.04,
    averageSaturation: 0.2,
    centerBrightRatio: 0.25,
    fingerprint: "1111000011110000",
    transmitterScore: 0.05,
    rainbowBarScore: 0,
    ...overrides,
  };
}

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

function createSplitBrightnessPixels(
  width: number,
  height: number,
  topRgb: [number, number, number],
  bottomRgb: [number, number, number],
) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const splitRow = Math.floor(height / 2);

  for (let y = 0; y < height; y++) {
    const rgb = y < splitRow ? topRgb : bottomRgb;

    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

function createVerticalSplitPixels(
  width: number,
  height: number,
  leftRgb: [number, number, number],
  rightRgb: [number, number, number],
) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const splitColumn = Math.floor(width / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = x < splitColumn ? leftRgb : rightRgb;
      const offset = (y * width + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
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
      const barIndex = Math.min(
        bars.length - 1,
        Math.floor((x / width) * bars.length),
      );
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

test("analyzeSceneGuardPixels changes fingerprint when the same layout gets brighter", () => {
  const dimMetrics = analyzeSceneGuardPixels({
    data: createSplitBrightnessPixels(8, 8, [24, 24, 24], [120, 120, 120]),
    width: 8,
    height: 8,
  });
  const brightMetrics = analyzeSceneGuardPixels({
    data: createSplitBrightnessPixels(8, 8, [56, 56, 56], [152, 152, 152]),
    width: 8,
    height: 8,
  });

  assert.notEqual(dimMetrics.fingerprint, brightMetrics.fingerprint);
  assert.ok(brightMetrics.averageLuma > dimMetrics.averageLuma);
});

test("classifySceneGuardSample does not treat a brightness-only change as frozen", () => {
  const firstMetrics = analyzeSceneGuardPixels({
    data: createSplitBrightnessPixels(8, 8, [24, 24, 24], [120, 120, 120]),
    width: 8,
    height: 8,
  });
  const secondMetrics = analyzeSceneGuardPixels({
    data: createSplitBrightnessPixels(8, 8, [56, 56, 56], [152, 152, 152]),
    width: 8,
    height: 8,
  });
  const thirdMetrics = analyzeSceneGuardPixels({
    data: createSplitBrightnessPixels(8, 8, [56, 56, 56], [152, 152, 152]),
    width: 8,
    height: 8,
  });

  const first = classifySceneGuardSample(createDefaultSceneGuardState(), firstMetrics, 1_000);
  const second = classifySceneGuardSample(first, secondMetrics, 2_000);
  const third = classifySceneGuardSample(second, thirdMetrics, 3_000);

  assert.equal(first.status, "healthy");
  assert.equal(second.status, "healthy");
  assert.equal(second.unchangedCount, 1);
  assert.equal(third.status, "healthy");
  assert.equal(third.unchangedCount, 2);
  assert.deepEqual(third.reasons, []);
});

test("analyzeSceneGuardPixels distinguishes different layouts", () => {
  const horizontalMetrics = analyzeSceneGuardPixels({
    data: createSplitBrightnessPixels(8, 8, [180, 180, 180], [20, 20, 20]),
    width: 8,
    height: 8,
  });
  const verticalMetrics = analyzeSceneGuardPixels({
    data: createVerticalSplitPixels(8, 8, [180, 180, 180], [20, 20, 20]),
    width: 8,
    height: 8,
  });

  assert.notEqual(horizontalMetrics.fingerprint, verticalMetrics.fingerprint);
});

test("classifySceneGuardSample flags possible transmitter fallback from a strong heuristic score", () => {
  const next = classifySceneGuardSample(
    createDefaultSceneGuardState(),
    createMetrics({
      averageLuma: 118,
      blackPixelRatio: 0.08,
      transmitterScore: 0.92,
    }),
    1_000,
  );

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["possibleTransmitterFallback"]);
});

test("classifySceneGuardSample flags the measured transmitter fallback profile", () => {
  const next = classifySceneGuardSample(
    createDefaultSceneGuardState(),
    createMetrics({
      averageLuma: 9.2288,
      blackPixelRatio: 0.81343,
      averageSaturation: 0.009224,
      centerBrightRatio: 0.1155,
      fingerprint: "0101010203060507152d1e0610010103",
      transmitterScore: 0.89,
    }),
    1_000,
  );

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["possibleTransmitterFallback"]);
});

test("classifySceneGuardSample flags a rainbow no-signal screen", () => {
  const metrics = analyzeSceneGuardPixels({
    data: createVerticalColorBarsPixels(84, 48),
    width: 84,
    height: 48,
  });

  const next = classifySceneGuardSample(
    createDefaultSceneGuardState(),
    metrics,
    1_000,
  );

  assert.ok(metrics.rainbowBarScore >= 6 / 7);
  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["possibleRainbowNoSignal"]);
});

test("classifySceneGuardSample does not freeze a bright opening graphic after three unchanged checks", () => {
  const openingMetrics = createMetrics({
    averageLuma: 40.664,
    blackPixelRatio: 0.145833,
    averageSaturation: 0.262552,
    centerBrightRatio: 0.5661,
    fingerprint: "1313131217807213181a492a14252e10",
    transmitterScore: 0,
  });

  const first = classifySceneGuardSample(
    createDefaultSceneGuardState(),
    openingMetrics,
    1_000,
  );
  const second = classifySceneGuardSample(first, openingMetrics, 2_000);
  const third = classifySceneGuardSample(second, openingMetrics, 3_000);

  assert.equal(third.status, "healthy");
  assert.deepEqual(third.reasons, []);
  assert.equal(third.unchangedCount, 3);
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

test("isSceneGuardFresh treats lastCheckedAt 0 as a valid timestamp", () => {
  const fresh = {
    ...createDefaultSceneGuardState(),
    status: "healthy" as const,
    lastCheckedAt: 0,
  };

  assert.equal(isSceneGuardFresh(fresh, 1), true);
  assert.equal(isSceneGuardFresh(fresh, 10_001), false);
});

test("formatSceneGuardReason returns operator-facing labels", () => {
  assert.equal(formatSceneGuardReason("fullBlack"), "Full black");
  assert.equal(formatSceneGuardReason("frozen"), "Frozen");
  assert.equal(
    formatSceneGuardReason("possibleTransmitterFallback"),
    "Possible transmitter fallback screen",
  );
  assert.equal(
    formatSceneGuardReason("possibleRainbowNoSignal"),
    "Possible rainbow no-signal screen",
  );
});
