export const SCENE_GUARD_ANALYSIS_WIDTH = 96;
export const SCENE_GUARD_ANALYSIS_FORMAT = "jpeg";
export const SCENE_GUARD_ANALYSIS_QUALITY = 40;
export const SCENE_GUARD_STALE_MS = 10_000;

const FULL_BLACK_LUMA_MAX = 6;
const FULL_BLACK_RATIO_MIN = 0.92;
const FROZEN_FRAME_THRESHOLD = 3;
const TRANSMITTER_SCORE_MIN = 0.78;

export type SceneGuardReason =
  | "fullBlack"
  | "frozen"
  | "possibleTransmitterFallback";

export type SceneGuardStatus = "healthy" | "flagged" | "unknown";

export type SceneGuardState = {
  status: SceneGuardStatus;
  reasons: SceneGuardReason[];
  lastCheckedAt: number | null;
  lastFingerprint: string | null;
  unchangedCount: number;
};

export type SceneGuardMetrics = {
  averageLuma: number;
  blackPixelRatio: number;
  fingerprint: string;
  transmitterScore: number;
};

export function createDefaultSceneGuardState(): SceneGuardState {
  return {
    status: "unknown",
    reasons: [],
    lastCheckedAt: null,
    lastFingerprint: null,
    unchangedCount: 0,
  };
}

export function formatSceneGuardReason(reason: SceneGuardReason) {
  switch (reason) {
    case "fullBlack":
      return "Full black";
    case "frozen":
      return "Frozen";
    case "possibleTransmitterFallback":
      return "Possible transmitter fallback screen";
  }
}

export function isSceneGuardFresh(
  sceneGuard: SceneGuardState | undefined,
  now: number,
) {
  if (sceneGuard?.lastCheckedAt == null) {
    return false;
  }

  return now - sceneGuard.lastCheckedAt <= SCENE_GUARD_STALE_MS;
}

function toLuma(red: number, green: number, blue: number) {
  return (red * 299 + green * 587 + blue * 114) / 1000;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function readAverageBandLuma(
  data: Uint8ClampedArray,
  width: number,
  startRow: number,
  endRow: number,
) {
  let total = 0;
  let samples = 0;

  for (let y = startRow; y < endRow; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      total += toLuma(data[offset], data[offset + 1], data[offset + 2]);
      samples++;
    }
  }

  return samples === 0 ? 0 : total / samples;
}

function buildFingerprint(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const columns = 4;
  const rows = 4;
  const cells: number[] = [];

  for (let row = 0; row < rows; row++) {
    const startY = Math.floor((row / rows) * height);
    const endY = Math.floor(((row + 1) / rows) * height);

    for (let column = 0; column < columns; column++) {
      const startX = Math.floor((column / columns) * width);
      const endX = Math.floor(((column + 1) / columns) * width);

      let total = 0;
      let samples = 0;

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const offset = (y * width + x) * 4;
          total += toLuma(data[offset], data[offset + 1], data[offset + 2]);
          samples++;
        }
      }

      cells.push(samples === 0 ? 0 : total / samples);
    }
  }

  return cells
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("");
}

export function analyzeSceneGuardPixels({
  data,
  width,
  height,
}: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): SceneGuardMetrics {
  let totalLuma = 0;
  let blackPixels = 0;
  const pixelCount = width * height;

  for (let index = 0; index < pixelCount; index++) {
    const offset = index * 4;
    const luma = toLuma(data[offset], data[offset + 1], data[offset + 2]);
    totalLuma += luma;

    if (luma <= FULL_BLACK_LUMA_MAX) {
      blackPixels++;
    }
  }

  const topBand = readAverageBandLuma(
    data,
    width,
    0,
    Math.max(1, Math.floor(height / 6)),
  );
  const middleBand = readAverageBandLuma(
    data,
    width,
    Math.floor(height / 3),
    Math.max(Math.floor((height * 2) / 3), Math.floor(height / 3) + 1),
  );
  const bottomBand = readAverageBandLuma(
    data,
    width,
    Math.max(height - Math.floor(height / 6), 0),
    height,
  );
  const centerContrast = Math.abs(middleBand - (topBand + bottomBand) / 2) / 255;
  const brightnessSymmetry = 1 - Math.min(1, Math.abs(topBand - bottomBand) / 255);

  return {
    averageLuma: pixelCount === 0 ? 0 : totalLuma / pixelCount,
    blackPixelRatio: pixelCount === 0 ? 0 : blackPixels / pixelCount,
    fingerprint: buildFingerprint(data, width, height),
    transmitterScore: clamp01(centerContrast * 0.65 + brightnessSymmetry * 0.35),
  };
}

export function classifySceneGuardSample(
  previous: SceneGuardState,
  metrics: SceneGuardMetrics,
  checkedAt: number,
): SceneGuardState {
  const unchangedCount =
    previous.lastFingerprint && previous.lastFingerprint === metrics.fingerprint
      ? previous.unchangedCount + 1
      : 1;

  const reasons: SceneGuardReason[] = [];

  if (
    metrics.averageLuma <= FULL_BLACK_LUMA_MAX &&
    metrics.blackPixelRatio >= FULL_BLACK_RATIO_MIN
  ) {
    reasons.push("fullBlack");
  }

  if (unchangedCount >= FROZEN_FRAME_THRESHOLD) {
    reasons.push("frozen");
  }

  if (metrics.transmitterScore >= TRANSMITTER_SCORE_MIN) {
    reasons.push("possibleTransmitterFallback");
  }

  return {
    status: reasons.length > 0 ? "flagged" : "healthy",
    reasons,
    lastCheckedAt: checkedAt,
    lastFingerprint: metrics.fingerprint,
    unchangedCount,
  };
}
