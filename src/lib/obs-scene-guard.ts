export const SCENE_GUARD_ANALYSIS_WIDTH = 96;
export const SCENE_GUARD_ANALYSIS_FORMAT = "jpeg";
export const SCENE_GUARD_ANALYSIS_QUALITY = 40;
export const SCENE_IMAGE_STALE_MS = 10_000;

const FULL_BLACK_LUMA_MAX = 6;
const FULL_BLACK_RATIO_MIN = 0.92;
const TRANSMITTER_SCORE_MIN = 0.78;
const BRIGHT_PIXEL_LUMA_MIN = 55;
const WHITE_NEUTRAL_LUMA_MIN = 75;
const WHITE_NEUTRAL_CHROMA_MAX = 24;
const TRANSMITTER_DARK_LUMA_MAX = 18;
const TRANSMITTER_BLACK_RATIO_MIN = 0.65;
const TRANSMITTER_SATURATION_MAX = 0.08;
const TRANSMITTER_LOWER_LEFT_OVERLAY_MIN = 0.012;
const TRANSMITTER_LOWER_RIGHT_OVERLAY_MIN = 0.0035;
const TRANSMITTER_UPPER_RIGHT_OVERLAY_MIN = 0.01;
const TRANSMITTER_CENTER_BRIGHT_RATIO_MAX = 0.2;
const RAINBOW_BAR_SCORE_MIN = 6 / 7;
const RAINBOW_SATURATION_MIN = 0.45;
const RAINBOW_CENTER_BRIGHT_RATIO_MIN = 0.75;
const RAINBOW_BLACK_RATIO_MAX = 0.12;

export type SceneImageGuardReason =
  | "fullBlack"
  | "possibleTransmitterFallback";
export type SourceHealthGuardReason = "frozenSource" | "laggySource";
export type SceneGuardReason = SceneImageGuardReason | SourceHealthGuardReason;
export type SceneGuardStatus = "healthy" | "flagged" | "unknown";

export type SceneImageGuardState = {
  status: SceneGuardStatus;
  reasons: SceneImageGuardReason[];
  lastCheckedAt: number | null;
};

export type SourceHealthGuardState = {
  status: SceneGuardStatus;
  reasons: SourceHealthGuardReason[];
  sourceName: string | null;
  sourceKind: string | null;
  lastCheckedAt: number | null;
  lastHealthyAt: number | null;
  lastProbeLatencyMs: number | null;
  consecutiveFailures: number;
  consecutiveSlowProbes: number;
};

export type SceneGuardState = {
  status: SceneGuardStatus;
  reasons: SceneGuardReason[];
  image: SceneImageGuardState;
  sourceHealth: SourceHealthGuardState;
};

export type SceneGuardMetrics = {
  averageLuma: number;
  blackPixelRatio: number;
  averageSaturation: number;
  centerBrightRatio: number;
  transmitterScore: number;
  rainbowBarScore: number;
};

export function createDefaultSceneImageGuardState(): SceneImageGuardState {
  return {
    status: "unknown",
    reasons: [],
    lastCheckedAt: null,
  };
}

export function createDefaultSourceHealthGuardState(): SourceHealthGuardState {
  return {
    status: "unknown",
    reasons: [],
    sourceName: null,
    sourceKind: null,
    lastCheckedAt: null,
    lastHealthyAt: null,
    lastProbeLatencyMs: null,
    consecutiveFailures: 0,
    consecutiveSlowProbes: 0,
  };
}

export function createDefaultSceneGuardState(): SceneGuardState {
  return composeSceneGuardState({
    image: createDefaultSceneImageGuardState(),
    sourceHealth: createDefaultSourceHealthGuardState(),
  });
}

export function formatSceneGuardReason(reason: SceneGuardReason) {
  switch (reason) {
    case "fullBlack":
      return "Full black";
    case "possibleTransmitterFallback":
      return "Possible transmitter fallback screen";
    case "frozenSource":
      return "Frozen source";
    case "laggySource":
      return "Laggy source";
  }
}

export function isSceneImageFresh(
  image: SceneImageGuardState | undefined,
  now: number,
) {
  if (image?.lastCheckedAt == null) {
    return false;
  }

  return now - image.lastCheckedAt <= SCENE_IMAGE_STALE_MS;
}

function toLuma(red: number, green: number, blue: number) {
  return (red * 299 + green * 587 + blue * 114) / 1000;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function toSaturation(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue);
  if (max === 0) {
    return 0;
  }

  const min = Math.min(red, green, blue);
  return (max - min) / max;
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

function readRegionSignal(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const startX = Math.floor(width * x1);
  const endX = Math.max(startX + 1, Math.ceil(width * x2));
  const startY = Math.floor(height * y1);
  const endY = Math.max(startY + 1, Math.ceil(height * y2));

  let brightPixels = 0;
  let whiteNeutralPixels = 0;
  let samples = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const luma = toLuma(red, green, blue);
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);

      if (luma >= BRIGHT_PIXEL_LUMA_MIN) {
        brightPixels++;
      }

      if (
        luma >= WHITE_NEUTRAL_LUMA_MIN &&
        chroma <= WHITE_NEUTRAL_CHROMA_MAX
      ) {
        whiteNeutralPixels++;
      }

      samples++;
    }
  }

  return {
    brightRatio: samples === 0 ? 0 : brightPixels / samples,
    whiteNeutralRatio: samples === 0 ? 0 : whiteNeutralPixels / samples,
  };
}

function readAverageRegionColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const startX = Math.floor(width * x1);
  const endX = Math.max(startX + 1, Math.ceil(width * x2));
  const startY = Math.floor(height * y1);
  const endY = Math.max(startY + 1, Math.ceil(height * y2));

  let totalRed = 0;
  let totalGreen = 0;
  let totalBlue = 0;
  let samples = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const offset = (y * width + x) * 4;
      totalRed += data[offset];
      totalGreen += data[offset + 1];
      totalBlue += data[offset + 2];
      samples++;
    }
  }

  if (samples === 0) {
    return { red: 0, green: 0, blue: 0 };
  }

  return {
    red: totalRed / samples,
    green: totalGreen / samples,
    blue: totalBlue / samples,
  };
}

function classifyRainbowBarColor(red: number, green: number, blue: number) {
  const maxChannel = Math.max(red, green, blue);
  if (maxChannel < 80) {
    return "other";
  }

  const saturation = toSaturation(red, green, blue);
  if (saturation <= 0.18 && toLuma(red, green, blue) >= 170) {
    return "white";
  }

  if (saturation < 0.45) {
    return "other";
  }

  const highThreshold = maxChannel * 0.72;
  const lowThreshold = maxChannel * 0.35;
  const redHigh = red >= highThreshold;
  const greenHigh = green >= highThreshold;
  const blueHigh = blue >= highThreshold;
  const redLow = red <= lowThreshold;
  const greenLow = green <= lowThreshold;
  const blueLow = blue <= lowThreshold;

  if (redHigh && greenHigh && blueLow) {
    return "yellow";
  }
  if (redLow && greenHigh && blueHigh) {
    return "cyan";
  }
  if (redLow && greenHigh && blueLow) {
    return "green";
  }
  if (redHigh && greenLow && blueHigh) {
    return "magenta";
  }
  if (redHigh && greenLow && blueLow) {
    return "red";
  }
  if (redLow && greenLow && blueHigh) {
    return "blue";
  }

  return "other";
}

function readRainbowBarScore(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const expectedBars = [
    "white",
    "yellow",
    "cyan",
    "green",
    "magenta",
    "red",
    "blue",
  ] as const;
  let matches = 0;

  for (let index = 0; index < expectedBars.length; index++) {
    const color = readAverageRegionColor(
      data,
      width,
      height,
      index / expectedBars.length,
      0.12,
      (index + 1) / expectedBars.length,
      0.42,
    );

    if (
      classifyRainbowBarColor(color.red, color.green, color.blue) ===
      expectedBars[index]
    ) {
      matches++;
    }
  }

  return matches / expectedBars.length;
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
  let totalSaturation = 0;
  const pixelCount = width * height;

  for (let index = 0; index < pixelCount; index++) {
    const offset = index * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const luma = toLuma(red, green, blue);
    totalLuma += luma;
    totalSaturation += toSaturation(red, green, blue);

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
  const centerContrast =
    Math.abs(middleBand - (topBand + bottomBand) / 2) / 255;
  const brightnessSymmetry =
    1 - Math.min(1, Math.abs(topBand - bottomBand) / 255);
  const lowerLeftSignal = readRegionSignal(data, width, height, 0, 0.78, 0.35, 1);
  const lowerRightSignal = readRegionSignal(
    data,
    width,
    height,
    0.78,
    0.84,
    1,
    1,
  );
  const upperRightSignal = readRegionSignal(
    data,
    width,
    height,
    0.88,
    0.02,
    1,
    0.18,
  );
  const centerSignal = readRegionSignal(
    data,
    width,
    height,
    0.28,
    0.28,
    0.72,
    0.68,
  );

  const averageLuma = pixelCount === 0 ? 0 : totalLuma / pixelCount;
  const blackPixelRatio = pixelCount === 0 ? 0 : blackPixels / pixelCount;
  const averageSaturation = pixelCount === 0 ? 0 : totalSaturation / pixelCount;
  const darkScore = clamp01((TRANSMITTER_DARK_LUMA_MAX - averageLuma) / 12);
  const blackScore = clamp01(
    (blackPixelRatio - 0.5) / (TRANSMITTER_BLACK_RATIO_MIN - 0.5),
  );
  const lowSaturationScore = clamp01(
    (TRANSMITTER_SATURATION_MAX - averageSaturation) /
      TRANSMITTER_SATURATION_MAX,
  );
  const lowerLeftOverlayScore = clamp01(
    lowerLeftSignal.whiteNeutralRatio / TRANSMITTER_LOWER_LEFT_OVERLAY_MIN,
  );
  const lowerRightOverlayScore = clamp01(
    lowerRightSignal.whiteNeutralRatio / TRANSMITTER_LOWER_RIGHT_OVERLAY_MIN,
  );
  const upperRightOverlayScore = clamp01(
    upperRightSignal.whiteNeutralRatio / TRANSMITTER_UPPER_RIGHT_OVERLAY_MIN,
  );
  const centerDarkScore = clamp01(
    (TRANSMITTER_CENTER_BRIGHT_RATIO_MAX - centerSignal.brightRatio) /
      TRANSMITTER_CENTER_BRIGHT_RATIO_MAX,
  );

  return {
    averageLuma,
    blackPixelRatio,
    averageSaturation,
    centerBrightRatio: centerSignal.brightRatio,
    transmitterScore: clamp01(
      darkScore * 0.18 +
        blackScore * 0.2 +
        lowSaturationScore * 0.12 +
        lowerLeftOverlayScore * 0.16 +
        lowerRightOverlayScore * 0.1 +
        upperRightOverlayScore * 0.1 +
        centerDarkScore * 0.08 +
        centerContrast * 0.03 +
        brightnessSymmetry * 0.03,
    ),
    rainbowBarScore: readRainbowBarScore(data, width, height),
  };
}

export function classifySceneImageSample(
  previous: SceneImageGuardState,
  metrics: SceneGuardMetrics,
  checkedAt: number,
): SceneImageGuardState {
  void previous;

  const reasons: SceneImageGuardReason[] = [];
  const looksLikeRainbowNoSignal =
    metrics.averageSaturation >= RAINBOW_SATURATION_MIN &&
    metrics.centerBrightRatio >= RAINBOW_CENTER_BRIGHT_RATIO_MIN &&
    metrics.blackPixelRatio <= RAINBOW_BLACK_RATIO_MAX &&
    metrics.rainbowBarScore >= RAINBOW_BAR_SCORE_MIN;

  if (
    metrics.averageLuma <= FULL_BLACK_LUMA_MAX &&
    metrics.blackPixelRatio >= FULL_BLACK_RATIO_MIN
  ) {
    reasons.push("fullBlack");
  }

  if (
    metrics.transmitterScore >= TRANSMITTER_SCORE_MIN ||
    looksLikeRainbowNoSignal
  ) {
    reasons.push("possibleTransmitterFallback");
  }

  return {
    status: reasons.length > 0 ? "flagged" : "healthy",
    reasons,
    lastCheckedAt: checkedAt,
  };
}

export function composeSceneGuardState({
  image,
  sourceHealth,
}: {
  image: SceneImageGuardState;
  sourceHealth: SourceHealthGuardState;
}): SceneGuardState {
  const reasons = [...image.reasons, ...sourceHealth.reasons];
  const status =
    reasons.length > 0
      ? "flagged"
      : image.status === "healthy" && sourceHealth.status === "healthy"
        ? "healthy"
        : "unknown";

  return {
    status,
    reasons,
    image,
    sourceHealth,
  };
}
