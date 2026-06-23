# OBS Source-Health Scene Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace screenshot-based frozen/laggy detection with source-health probing while keeping image heuristics for black and transmitter fallback scenes.

**Architecture:** Keep `ObsClient` as the guard orchestrator, but split monitoring into two loops: an image-analysis loop for `fullBlack` and `possibleTransmitterFallback`, and a source-health loop for `frozenSource` and `laggySource`. Move source selection and source-health classification into a focused helper module, keep switching synchronous against cached state, and preserve the existing confirmation-before-live flow.

**Tech Stack:** TypeScript, React 19, obs-websocket-js v5, Node built-in test runner, TanStack Start, Radix Alert Dialog

---

## File Structure

- Modify: `src/lib/obs-scene-guard.ts`
  Purpose: keep the low-resolution image heuristics, remove unchanged-frame freeze detection, define the new nested guard state, and format the new reason labels.
- Create: `src/lib/obs-source-health.ts`
  Purpose: resolve the primary monitored source for a scene and classify source-health probes into `healthy`, `flagged`, or `unknown`.
- Modify: `src/lib/obs-client.ts`
  Purpose: add input/source caches, event subscriptions, dual watchdog loops, freshness-aware switch gating, and scene-to-source resolution.
- Modify: `src/components/ObsPanel.tsx`
  Purpose: surface the updated warning state in the scene matrix while keeping the existing pending-switch dialog flow.
- Modify: `tests/unit/lib/obs-scene-guard.test.ts`
  Purpose: verify the image-only guard behavior after removing fingerprint-based freeze detection.
- Create: `tests/unit/lib/obs-source-health.test.ts`
  Purpose: verify source selection, staleness, and source-health classification without OBS.
- Modify: `tests/integration/lib/obs-client.remote-studio.test.ts`
  Purpose: verify the dual-loop `ObsClient` behavior with a richer fake OBS transport.
- Create: `tests/contract/obs-panel.scene-guard-contract.test.ts`
  Purpose: source-contract the UI warning affordance and reason-label wiring.
- Modify: `package.json`
  Purpose: extend the focused scene-guard test script to include the new unit and contract files.

### Task 1: Refactor the Pure Scene-Image Guard

**Files:**
- Modify: `src/lib/obs-scene-guard.ts`
- Modify: `tests/unit/lib/obs-scene-guard.test.ts`
- Test: `tests/unit/lib/obs-scene-guard.test.ts`

- [ ] **Step 1: Rewrite the unit tests so the image guard no longer expects freeze detection**

```ts
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

test("classifySceneImageSample flags a full-black frame", () => {
  const metrics = analyzeSceneGuardPixels({
    data: createSolidPixels(8, 8, [0, 0, 0]),
    width: 8,
    height: 8,
  });

  const next = classifySceneImageSample(
    createDefaultSceneImageGuardState(),
    metrics,
    1_000,
  );

  assert.equal(next.status, "flagged");
  assert.deepEqual(next.reasons, ["fullBlack"]);
});

test("classifySceneImageSample surfaces rainbow no-signal bars as possibleTransmitterFallback", () => {
  const metrics = analyzeSceneGuardPixels({
    data: createVerticalColorBarsPixels(84, 48),
    width: 84,
    height: 48,
  });

  const next = classifySceneImageSample(
    createDefaultSceneImageGuardState(),
    metrics,
    1_000,
  );

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
    isSceneImageFresh(
      { status: "healthy", reasons: [], lastCheckedAt: 1_000 },
      10_999,
    ),
    true,
  );
  assert.equal(
    isSceneImageFresh(
      { status: "healthy", reasons: [], lastCheckedAt: 1_000 },
      11_001,
    ),
    false,
  );
});

test("formatSceneGuardReason returns the new source-health labels", () => {
  assert.equal(formatSceneGuardReason("frozenSource"), "Frozen source");
  assert.equal(formatSceneGuardReason("laggySource"), "Laggy source");
});
```

- [ ] **Step 2: Run the image-guard unit file to verify it fails on the old exports and reason model**

Run: `node --test --experimental-strip-types tests/unit/lib/obs-scene-guard.test.ts`

Expected: FAIL with missing exports such as `classifySceneImageSample` or mismatched reasons such as `frozen` and `possibleRainbowNoSignal`.

- [ ] **Step 3: Refactor `src/lib/obs-scene-guard.ts` into an image-only classifier with nested state**

```ts
export const SCENE_GUARD_ANALYSIS_WIDTH = 96;
export const SCENE_GUARD_ANALYSIS_FORMAT = "jpeg";
export const SCENE_GUARD_ANALYSIS_QUALITY = 40;
export const SCENE_IMAGE_STALE_MS = 10_000;

const FULL_BLACK_LUMA_MAX = 6;
const FULL_BLACK_RATIO_MIN = 0.92;
const TRANSMITTER_SCORE_MIN = 0.78;
const RAINBOW_BAR_SCORE_MIN = 6 / 7;
const RAINBOW_SATURATION_MIN = 0.45;
const RAINBOW_CENTER_BRIGHT_RATIO_MIN = 0.75;
const RAINBOW_BLACK_RATIO_MAX = 0.12;

export type SceneImageGuardReason = "fullBlack" | "possibleTransmitterFallback";
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

export function classifySceneImageSample(
  previous: SceneImageGuardState,
  metrics: SceneGuardMetrics,
  checkedAt: number,
): SceneImageGuardState {
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
```

- [ ] **Step 4: Re-run the image-guard unit file until it passes**

Run: `node --test --experimental-strip-types tests/unit/lib/obs-scene-guard.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the image-guard refactor**

```bash
git add src/lib/obs-scene-guard.ts tests/unit/lib/obs-scene-guard.test.ts
git commit -m "refactor: split image guard from source health"
```

### Task 2: Add the Pure Source-Health Module

**Files:**
- Create: `src/lib/obs-source-health.ts`
- Create: `tests/unit/lib/obs-source-health.test.ts`
- Test: `tests/unit/lib/obs-source-health.test.ts`

- [ ] **Step 1: Create failing tests for source selection, freshness, freeze, and lag classification**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultSourceHealthGuardState } from "../../../src/lib/obs-scene-guard.ts";
import {
  applySourceHealthProbe,
  isSourceHealthFresh,
  pickPrimarySceneSource,
} from "../../../src/lib/obs-source-health.ts";

function createProbeSample(overrides: Partial<Parameters<typeof applySourceHealthProbe>[2]> = {}) {
  return {
    checkedAt: 1_000,
    latencyMs: 35,
    probeOk: true,
    sourceActive: true,
    sourceShowing: true,
    renderSkippedFramesDelta: 0,
    averageFrameRenderTimeMs: 8,
    ...overrides,
  };
}

test("pickPrimarySceneSource prefers an enabled dshow_input over a browser_source", () => {
  const next = pickPrimarySceneSource(
    [
      { sceneItemId: 7, sourceName: "Scene A Browser", sceneItemEnabled: true },
      { sceneItemId: 8, sourceName: "Scene A Camera", sceneItemEnabled: true },
    ],
    {
      "Scene A Browser": {
        inputKind: "browser_source",
        unversionedInputKind: "browser_source",
      },
      "Scene A Camera": {
        inputKind: "dshow_input",
        unversionedInputKind: "dshow_input",
      },
    },
  );

  assert.deepEqual(next, {
    sceneItemId: 8,
    sourceName: "Scene A Camera",
    sourceKind: "dshow_input",
  });
});

test("applySourceHealthProbe stays healthy for a fast successful probe", () => {
  const next = applySourceHealthProbe(
    createDefaultSourceHealthGuardState(),
    {
      sceneItemId: 8,
      sourceName: "Scene A Camera",
      sourceKind: "dshow_input",
    },
    createProbeSample(),
  );

  assert.equal(next.status, "healthy");
  assert.deepEqual(next.reasons, []);
  assert.equal(next.lastHealthyAt, 1_000);
});

test("applySourceHealthProbe flags frozenSource after three failed probes", () => {
  const primary = {
    sceneItemId: 8,
    sourceName: "Scene A Camera",
    sourceKind: "dshow_input",
  };
  const failedSample = createProbeSample({
    probeOk: false,
    sourceActive: false,
    sourceShowing: false,
  });

  const first = applySourceHealthProbe(
    createDefaultSourceHealthGuardState(),
    primary,
    failedSample,
  );
  const second = applySourceHealthProbe(first, primary, {
    ...failedSample,
    checkedAt: 1_050,
  });
  const third = applySourceHealthProbe(second, primary, {
    ...failedSample,
    checkedAt: 1_100,
  });

  assert.equal(third.status, "flagged");
  assert.deepEqual(third.reasons, ["frozenSource"]);
});

test("applySourceHealthProbe flags laggySource after three slow probes", () => {
  const primary = {
    sceneItemId: 11,
    sourceName: "Scene B Browser",
    sourceKind: "browser_source",
  };
  const slowSample = createProbeSample({
    latencyMs: 165,
    renderSkippedFramesDelta: 2,
    averageFrameRenderTimeMs: 24,
  });

  const first = applySourceHealthProbe(
    createDefaultSourceHealthGuardState(),
    primary,
    slowSample,
  );
  const second = applySourceHealthProbe(first, primary, {
    ...slowSample,
    checkedAt: 1_050,
  });
  const third = applySourceHealthProbe(second, primary, {
    ...slowSample,
    checkedAt: 1_100,
  });

  assert.equal(third.status, "flagged");
  assert.deepEqual(third.reasons, ["laggySource"]);
});

test("isSourceHealthFresh rejects stale probes", () => {
  assert.equal(
    isSourceHealthFresh(
      {
        ...createDefaultSourceHealthGuardState(),
        lastCheckedAt: 1_000,
      },
      1_200,
    ),
    true,
  );
  assert.equal(
    isSourceHealthFresh(
      {
        ...createDefaultSourceHealthGuardState(),
        lastCheckedAt: 1_000,
      },
      1_260,
    ),
    false,
  );
});
```

- [ ] **Step 2: Run the new source-health unit file to verify it fails because the module does not exist yet**

Run: `node --test --experimental-strip-types tests/unit/lib/obs-source-health.test.ts`

Expected: FAIL with module-resolution errors for `src/lib/obs-source-health.ts`.

- [ ] **Step 3: Implement the pure source-health module**

```ts
import type { SourceHealthGuardState } from "./obs-scene-guard.ts";

export const SOURCE_HEALTH_STALE_MS = 250;
const SOURCE_HEALTH_SLOW_PROBE_MS = 120;
const SOURCE_HEALTH_FAILURE_THRESHOLD = 3;
const SOURCE_HEALTH_SLOW_THRESHOLD = 3;
const SOURCE_HEALTH_RENDER_SKIPS_THRESHOLD = 2;
const SOURCE_HEALTH_RENDER_TIME_MS_THRESHOLD = 22;

export type ScenePrimarySource = {
  sceneItemId: number | null;
  sourceName: string | null;
  sourceKind: string | null;
};

export type SourceHealthProbeSample = {
  checkedAt: number;
  latencyMs: number | null;
  probeOk: boolean;
  sourceActive: boolean | null;
  sourceShowing: boolean | null;
  renderSkippedFramesDelta: number;
  averageFrameRenderTimeMs: number;
};

export function pickPrimarySceneSource(
  sceneItems: Array<{
    sceneItemId?: number;
    sourceName?: string;
    sceneItemEnabled?: boolean;
  }>,
  inputCatalog: Record<
    string,
    { inputKind: string; unversionedInputKind: string | null }
  >,
): ScenePrimarySource {
  const candidates = sceneItems
    .filter((item) => item.sceneItemEnabled !== false)
    .map((item) => {
      const sourceName = String(item.sourceName ?? "");
      const catalogEntry = inputCatalog[sourceName];
      const sourceKind =
        catalogEntry?.unversionedInputKind ?? catalogEntry?.inputKind ?? null;

      return {
        sceneItemId:
          typeof item.sceneItemId === "number" ? item.sceneItemId : null,
        sourceName: sourceName || null,
        sourceKind,
      };
    })
    .filter(
      (candidate): candidate is {
        sceneItemId: number | null;
        sourceName: string;
        sourceKind: string;
      } => candidate.sourceName != null && candidate.sourceKind != null,
    );

  for (const preferredKind of ["dshow_input", "browser_source"]) {
    const match = candidates.find(
      (candidate) => candidate.sourceKind === preferredKind,
    );
    if (match) {
      return match;
    }
  }

  return (
    candidates[0] ?? {
      sceneItemId: null,
      sourceName: null,
      sourceKind: null,
    }
  );
}

export function isSourceHealthFresh(
  state: SourceHealthGuardState | undefined,
  now: number,
) {
  if (state?.lastCheckedAt == null) {
    return false;
  }

  return now - state.lastCheckedAt <= SOURCE_HEALTH_STALE_MS;
}

export function applySourceHealthProbe(
  previous: SourceHealthGuardState,
  primary: ScenePrimarySource,
  sample: SourceHealthProbeSample,
): SourceHealthGuardState {
  if (!primary.sourceName || !primary.sourceKind) {
    return {
      ...previous,
      status: "unknown",
      reasons: [],
      sourceName: null,
      sourceKind: null,
      lastCheckedAt: sample.checkedAt,
      lastProbeLatencyMs: sample.latencyMs,
      consecutiveFailures: 0,
      consecutiveSlowProbes: 0,
    };
  }

  const hardFailure =
    !sample.probeOk ||
    sample.sourceActive === false ||
    sample.sourceShowing === false;
  const slowProbe =
    sample.probeOk &&
    ((sample.latencyMs ?? 0) >= SOURCE_HEALTH_SLOW_PROBE_MS ||
      sample.renderSkippedFramesDelta >= SOURCE_HEALTH_RENDER_SKIPS_THRESHOLD ||
      sample.averageFrameRenderTimeMs >=
        SOURCE_HEALTH_RENDER_TIME_MS_THRESHOLD);

  const consecutiveFailures = hardFailure
    ? previous.consecutiveFailures + 1
    : 0;
  const consecutiveSlowProbes =
    !hardFailure && slowProbe ? previous.consecutiveSlowProbes + 1 : 0;

  const reasons =
    consecutiveFailures >= SOURCE_HEALTH_FAILURE_THRESHOLD
      ? (["frozenSource"] as const)
      : consecutiveSlowProbes >= SOURCE_HEALTH_SLOW_THRESHOLD
        ? (["laggySource"] as const)
        : [];

  return {
    status: reasons.length > 0 ? "flagged" : sample.probeOk ? "healthy" : "unknown",
    reasons: [...reasons],
    sourceName: primary.sourceName,
    sourceKind: primary.sourceKind,
    lastCheckedAt: sample.checkedAt,
    lastHealthyAt:
      reasons.length === 0 && sample.probeOk
        ? sample.checkedAt
        : previous.lastHealthyAt,
    lastProbeLatencyMs: sample.latencyMs,
    consecutiveFailures,
    consecutiveSlowProbes,
  };
}
```

- [ ] **Step 4: Re-run both unit files until they pass together**

Run: `node --test --experimental-strip-types tests/unit/lib/obs-scene-guard.test.ts tests/unit/lib/obs-source-health.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the source-health helper**

```bash
git add src/lib/obs-source-health.ts tests/unit/lib/obs-source-health.test.ts
git commit -m "feat: add pure OBS source health classifier"
```

### Task 3: Extend the Integration Fixture and Add Red Dual-Loop Tests

**Files:**
- Modify: `tests/integration/lib/obs-client.remote-studio.test.ts`
- Modify: `package.json`
- Test: `tests/integration/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Expand the fake OBS transport so it can answer input, scene-item, source-active, and stats requests**

```ts
type FakeObs = {
  calls: CallRecord[];
  responses: Map<string, unknown>;
  screenshotResponses: Map<string, unknown>;
  handlers: Map<string, (payload: any) => void>;
  inputList: Array<{
    inputName: string;
    inputKind: string;
    unversionedInputKind: string;
  }>;
  sceneItemsByScene: Map<string, Array<{
    sceneItemId: number;
    sourceName: string;
    sceneItemEnabled: boolean;
  }>>;
  sourceActivity: Map<string, { videoActive: boolean; videoShowing: boolean }>;
  statsQueue: Array<{
    renderSkippedFrames: number;
    averageFrameRenderTime: number;
    outputSkippedFrames: number;
    outputTotalFrames: number;
    renderTotalFrames: number;
  }>;
  onCall?: (method: string, args?: Record<string, unknown>) => void;
  call: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  trigger: (event: string, payload: unknown) => void;
};

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
  screenshotResponses: new Map<string, unknown>([
    ["Scene A", { imageData: "c2NlbmUtYQ==" }],
    ["Scene B", { imageData: "c2NlbmUtYg==" }],
    ["Scene A Camera", { imageData: "Y2FtLWE=" }],
    ["Scene B Browser", { imageData: "YnJvd3Nlci1i" }],
  ]),
  inputList: [
    {
      inputName: "Scene A Camera",
      inputKind: "dshow_input",
      unversionedInputKind: "dshow_input",
    },
    {
      inputName: "Scene B Browser",
      inputKind: "browser_source",
      unversionedInputKind: "browser_source",
    },
  ],
  sceneItemsByScene: new Map([
    [
      "Scene A",
      [{ sceneItemId: 8, sourceName: "Scene A Camera", sceneItemEnabled: true }],
    ],
    [
      "Scene B",
      [{ sceneItemId: 11, sourceName: "Scene B Browser", sceneItemEnabled: true }],
    ],
  ]),
  sourceActivity: new Map([
    ["Scene A Camera", { videoActive: true, videoShowing: true }],
    ["Scene B Browser", { videoActive: true, videoShowing: true }],
  ]),
  statsQueue: [],
  async call(method, args) {
    this.onCall?.(method, args);
    this.calls.push({ method, args });

    if (method === "GetInputList") {
      return { inputs: this.inputList };
    }

    if (method === "GetSceneItemList") {
      return {
        sceneItems: this.sceneItemsByScene.get(String(args?.sceneName ?? "")) ?? [],
      };
    }

    if (method === "GetSourceActive") {
      return (
        this.sourceActivity.get(String(args?.sourceName ?? "")) ?? {
          videoActive: false,
          videoShowing: false,
        }
      );
    }

    if (method === "GetStats") {
      return (
        this.statsQueue.shift() ?? {
          cpuUsage: 12,
          memoryUsage: 450,
          availableDiskSpace: 1000,
          activeFps: 60,
          averageFrameRenderTime: 8,
          renderSkippedFrames: 0,
          renderTotalFrames: 1000,
          outputSkippedFrames: 0,
          outputTotalFrames: 1000,
        }
      );
    }

    if (method === "GetSourceScreenshot") {
      const sourceName = String(args?.sourceName ?? "");
      const response = this.screenshotResponses.get(sourceName);
      if (response == null) {
        throw new Error(`No fake screenshot response for ${sourceName}`);
      }
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }

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
```

- [ ] **Step 2: Add failing integration tests for primary-source resolution, freeze/lag classification, and stale bypass**

```ts
test("source-health pass resolves the primary capture source for Scene A", async () => {
  const { client } = createClient();

  await client.refreshAll();
  await (client as any).runSourceHealthPass();

  assert.equal(
    client.state.sceneGuard["Scene A"]?.sourceHealth.sourceName,
    "Scene A Camera",
  );
  assert.equal(
    client.state.sceneGuard["Scene A"]?.sourceHealth.sourceKind,
    "dshow_input",
  );
});

test("three failed source-health probes flag frozenSource", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  fakeObs.screenshotResponses.set("Scene A Camera", new Error("probe failed"));
  fakeObs.sourceActivity.set("Scene A Camera", {
    videoActive: false,
    videoShowing: false,
  });

  await client.refreshAll();
  await (client as any).runSourceHealthPass();
  advanceTime(50);
  await (client as any).runSourceHealthPass();
  advanceTime(50);
  await (client as any).runSourceHealthPass();

  assert.deepEqual(client.state.sceneGuard["Scene A"]?.sourceHealth.reasons, [
    "frozenSource",
  ]);
});

test("three slow source-health probes flag laggySource", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  fakeObs.onCall = (method) => {
    if (method === "GetSourceScreenshot") {
      advanceTime(160);
    }
  };
  fakeObs.statsQueue.push(
    {
      cpuUsage: 12,
      memoryUsage: 450,
      availableDiskSpace: 1000,
      activeFps: 60,
      averageFrameRenderTime: 8,
      renderSkippedFrames: 0,
      renderTotalFrames: 1000,
      outputSkippedFrames: 0,
      outputTotalFrames: 1000,
    },
    {
      cpuUsage: 14,
      memoryUsage: 452,
      availableDiskSpace: 1000,
      activeFps: 60,
      averageFrameRenderTime: 24,
      renderSkippedFrames: 2,
      renderTotalFrames: 1001,
      outputSkippedFrames: 0,
      outputTotalFrames: 1001,
    },
  );

  await client.refreshAll();
  await (client as any).runSourceHealthPass();
  await (client as any).runSourceHealthPass();
  await (client as any).runSourceHealthPass();

  assert.deepEqual(client.state.sceneGuard["Scene A"]?.sourceHealth.reasons, [
    "laggySource",
  ]);
});

test("stale source-health data degrades to unknown and does not block a switch", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  client.state.sceneGuard["Scene B"] = {
    status: "flagged",
    reasons: ["laggySource"],
    image: {
      status: "healthy",
      reasons: [],
      lastCheckedAt: 1_000,
    },
    sourceHealth: {
      status: "flagged",
      reasons: ["laggySource"],
      sourceName: "Scene B Browser",
      sourceKind: "browser_source",
      lastCheckedAt: 1_000,
      lastHealthyAt: 900,
      lastProbeLatencyMs: 190,
      consecutiveFailures: 0,
      consecutiveSlowProbes: 3,
    },
  } as never;
  advanceTime(300);

  await client.setScene("Scene B");

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
  assert.equal(client.state.pendingProgramSwitch, null);
});
```

- [ ] **Step 3: Extend the focused scene-guard script to include the new source-health unit file**

```json
{
  "scripts": {
    "test:obs-scene-guard": "node --test --experimental-strip-types tests/unit/lib/obs-scene-guard.test.ts tests/unit/lib/obs-source-health.test.ts tests/integration/lib/obs-client.remote-studio.test.ts"
  }
}
```

- [ ] **Step 4: Run the focused scene-guard suite to verify the new integration tests fail before `ObsClient` is updated**

Run: `npm run test:obs-scene-guard`

Expected: FAIL with missing methods such as `runSourceHealthPass`, missing nested `sceneGuard` state, or stale-gating mismatches.

- [ ] **Step 5: Commit the red integration fixture and script changes**

```bash
git add tests/integration/lib/obs-client.remote-studio.test.ts package.json
git commit -m "test: cover OBS source health guard behavior"
```

### Task 4: Implement Dual-Loop Guarding in `ObsClient`

**Files:**
- Modify: `src/lib/obs-client.ts`
- Test: `tests/integration/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Expand the imports, state fields, and connect options for source-health monitoring**

```ts
import OBSWebSocket, {
  EventSubscription,
  RequestBatchExecutionType,
} from "obs-websocket-js";
import type { SceneGuardMetrics, SceneGuardState } from "./obs-scene-guard.ts";
import {
  SCENE_GUARD_ANALYSIS_FORMAT,
  SCENE_GUARD_ANALYSIS_QUALITY,
  SCENE_GUARD_ANALYSIS_WIDTH,
  classifySceneImageSample,
  composeSceneGuardState,
  createDefaultSceneGuardState,
  createDefaultSceneImageGuardState,
  createDefaultSourceHealthGuardState,
  isSceneImageFresh,
} from "./obs-scene-guard.ts";
import {
  applySourceHealthProbe,
  isSourceHealthFresh,
  pickPrimarySceneSource,
  type ScenePrimarySource,
} from "./obs-source-health.ts";

const SOURCE_HEALTH_PROBE_WIDTH = 32;
const SOURCE_HEALTH_PROBE_QUALITY = 20;
const SOURCE_HEALTH_LOOP_DELAY_MS = 25;

type ObsInputCatalogEntry = {
  inputKind: string;
  unversionedInputKind: string | null;
};

type ObsSourceTelemetry = {
  videoActive: boolean | null;
  videoShowing: boolean | null;
  updatedAt: number | null;
};

export class ObsClient {
  obs = new OBSWebSocket();
  private listeners = new Set<(s: ObsState) => void>();
  private programMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorRefreshInFlight: Promise<void> | null = null;
  private sceneImageTimer: ReturnType<typeof setTimeout> | null = null;
  private sceneImagePassInFlight: Promise<void> | null = null;
  private sourceHealthTimer: ReturnType<typeof setTimeout> | null = null;
  private sourceHealthPassInFlight: Promise<void> | null = null;
  private guardLoopsEnabled = false;
  private nextSceneImageIndex = 0;
  private nextSourceHealthIndex = 0;
  private inputCatalog: Record<string, ObsInputCatalogEntry> = {};
  private scenePrimarySources: Record<string, ScenePrimarySource> = {};
  private sourceTelemetry: Record<string, ObsSourceTelemetry> = {};
  private readonly analyzeSceneGuardImageDataUrl;
  private readonly now;
  state: ObsState = createDefaultObsState();
}

async connect(config: ObsConfig) {
  await this.obs.connect(config.url, config.password || undefined, {
    eventSubscriptions:
      EventSubscription.All |
      EventSubscription.InputActiveStateChanged |
      EventSubscription.InputShowStateChanged,
  });
}
```

- [ ] **Step 2: Add input-catalog refresh, source-telemetry tracking, scene-source resolution, and nested guard updates**

```ts
private async refreshInputCatalog() {
  const { inputs }: any = await this.obs.call("GetInputList");
  this.inputCatalog = Object.fromEntries(
    inputs.map((input: any) => [
      String(input.inputName),
      {
        inputKind: String(input.inputKind),
        unversionedInputKind:
          input.unversionedInputKind == null
            ? null
            : String(input.unversionedInputKind),
      },
    ]),
  );
}

private updateSourceTelemetry(
  sourceName: string,
  patch: Partial<ObsSourceTelemetry>,
) {
  this.sourceTelemetry[sourceName] = {
    videoActive: this.sourceTelemetry[sourceName]?.videoActive ?? null,
    videoShowing: this.sourceTelemetry[sourceName]?.videoShowing ?? null,
    updatedAt: this.sourceTelemetry[sourceName]?.updatedAt ?? null,
    ...patch,
  };
}

private async resolvePrimarySource(sceneName: string) {
  const { sceneItems }: any = await this.obs.call("GetSceneItemList", { sceneName });
  const primary = pickPrimarySceneSource(sceneItems as any[], this.inputCatalog);
  this.scenePrimarySources[sceneName] = primary;
  return primary;
}

private updateSceneGuard(
  sceneName: string,
  patch: Partial<Pick<SceneGuardState, "image" | "sourceHealth">>,
) {
  const previous =
    this.state.sceneGuard[sceneName] ?? createDefaultSceneGuardState();
  const image = patch.image ?? previous.image;
  const sourceHealth = patch.sourceHealth ?? previous.sourceHealth;

  this.update({
    sceneGuard: {
      ...this.state.sceneGuard,
      [sceneName]: composeSceneGuardState({ image, sourceHealth }),
    },
  });
}
```

- [ ] **Step 3: Split the old watchdog into `runSceneImagePass()` and `runSourceHealthPass()`**

```ts
private scheduleSceneImagePass() {
  if (
    this.sceneImageTimer ||
    !this.guardLoopsEnabled ||
    !this.state.connected ||
    this.state.scenes.length === 0
  ) {
    return;
  }

  this.sceneImageTimer = setTimeout(() => {
    this.sceneImageTimer = null;
    void this.runSceneImagePass();
  }, 0);
  this.sceneImageTimer.unref?.();
}

private scheduleSourceHealthPass() {
  if (
    this.sourceHealthTimer ||
    !this.guardLoopsEnabled ||
    !this.state.connected ||
    this.state.scenes.length === 0
  ) {
    return;
  }

  this.sourceHealthTimer = setTimeout(() => {
    this.sourceHealthTimer = null;
    void this.runSourceHealthPass();
  }, SOURCE_HEALTH_LOOP_DELAY_MS);
  this.sourceHealthTimer.unref?.();
}

private async runSceneImagePass() {
  if (!this.state.connected || this.state.scenes.length === 0) {
    return;
  }

  if (this.sceneImagePassInFlight) {
    return this.sceneImagePassInFlight;
  }

  const sceneName = this.state.scenes[this.nextSceneImageIndex];

  this.sceneImagePassInFlight = (async () => {
    try {
      const screenshot: any = await this.obs.call("GetSourceScreenshot", {
        sourceName: sceneName,
        imageFormat: SCENE_GUARD_ANALYSIS_FORMAT,
        imageWidth: SCENE_GUARD_ANALYSIS_WIDTH,
        imageCompressionQuality: SCENE_GUARD_ANALYSIS_QUALITY,
      });

      const imageDataUrl = toScreenshotDataUrl(
        screenshot.imageData,
        SCENE_GUARD_ANALYSIS_FORMAT,
      );
      const metrics = await this.analyzeSceneGuardImageDataUrl(imageDataUrl);
      const previous =
        this.state.sceneGuard[sceneName]?.image ??
        createDefaultSceneImageGuardState();

      this.updateSceneGuard(sceneName, {
        image: classifySceneImageSample(previous, metrics, this.now()),
      });
    } catch {
      this.updateSceneGuard(sceneName, {
        image: createDefaultSceneImageGuardState(),
      });
    } finally {
      this.sceneImagePassInFlight = null;
      this.nextSceneImageIndex =
        this.state.scenes.length === 0
          ? 0
          : (this.nextSceneImageIndex + 1) % this.state.scenes.length;
      this.scheduleSceneImagePass();
    }
  })();

  return this.sceneImagePassInFlight;
}

private async runSourceHealthPass() {
  if (!this.state.connected || this.state.scenes.length === 0) {
    return;
  }

  if (this.sourceHealthPassInFlight) {
    return this.sourceHealthPassInFlight;
  }

  const sceneName = this.state.scenes[this.nextSourceHealthIndex];

  this.sourceHealthPassInFlight = (async () => {
    const previous =
      this.state.sceneGuard[sceneName]?.sourceHealth ??
      createDefaultSourceHealthGuardState();
    const primary =
      this.scenePrimarySources[sceneName] ?? (await this.resolvePrimarySource(sceneName));

    if (!primary.sourceName) {
      this.updateSceneGuard(sceneName, {
        sourceHealth: {
          ...createDefaultSourceHealthGuardState(),
          lastCheckedAt: this.now(),
        },
      });
      return;
    }

    const startedAt = this.now();
    const results = await this.obs.callBatch(
      [
        { requestType: "GetStats" },
        { requestType: "GetSourceActive", requestData: { sourceName: primary.sourceName } },
        {
          requestType: "GetSourceScreenshot",
          requestData: {
            sourceName: primary.sourceName,
            imageFormat: "jpeg",
            imageWidth: SOURCE_HEALTH_PROBE_WIDTH,
            imageCompressionQuality: SOURCE_HEALTH_PROBE_QUALITY,
          },
        },
        { requestType: "GetStats" },
      ],
      {
        executionType: RequestBatchExecutionType.SerialRealtime,
        haltOnFailure: false,
      },
    );

    const [beforeStats, active, screenshot, afterStats] = results;
    const telemetry = this.sourceTelemetry[primary.sourceName] ?? {
      videoActive: null,
      videoShowing: null,
      updatedAt: null,
    };

    this.updateSceneGuard(sceneName, {
      sourceHealth: applySourceHealthProbe(previous, primary, {
        checkedAt: this.now(),
        latencyMs: this.now() - startedAt,
        probeOk: screenshot.requestStatus.result,
        sourceActive: active.requestStatus.result
          ? Boolean((active.responseData as any).videoActive)
          : telemetry.videoActive,
        sourceShowing:
          telemetry.videoShowing ??
          (active.requestStatus.result
            ? Boolean((active.responseData as any).videoShowing)
            : null),
        renderSkippedFramesDelta:
          beforeStats.requestStatus.result && afterStats.requestStatus.result
            ? Number((afterStats.responseData as any).renderSkippedFrames) -
              Number((beforeStats.responseData as any).renderSkippedFrames)
            : 0,
        averageFrameRenderTimeMs: afterStats.requestStatus.result
          ? Number((afterStats.responseData as any).averageFrameRenderTime)
          : 0,
      }),
    });
  })().finally(() => {
    this.sourceHealthPassInFlight = null;
    this.nextSourceHealthIndex =
      this.state.scenes.length === 0
        ? 0
        : (this.nextSourceHealthIndex + 1) % this.state.scenes.length;
    this.scheduleSourceHealthPass();
  });

  return this.sourceHealthPassInFlight;
}
```

- [ ] **Step 4: Make switch gating consult a freshness-aware effective guard state**

```ts
private getEffectiveSceneGuard(sceneName: string) {
  const sceneGuard = this.state.sceneGuard[sceneName];
  if (!sceneGuard) {
    return null;
  }

  const image = isSceneImageFresh(sceneGuard.image, this.now())
    ? sceneGuard.image
    : createDefaultSceneImageGuardState();
  const sourceHealth = isSourceHealthFresh(sceneGuard.sourceHealth, this.now())
    ? sceneGuard.sourceHealth
    : {
        ...sceneGuard.sourceHealth,
        status: "unknown" as const,
        reasons: [],
      };

  return composeSceneGuardState({ image, sourceHealth });
}

private async requestProgramScene(
  sceneName: string,
  requestedFrom: PendingProgramSwitch["requestedFrom"],
) {
  if (!this.state.sceneGuardEnabled) {
    await this.sendProgramScene(sceneName, requestedFrom);
    return;
  }

  const sceneGuard = this.getEffectiveSceneGuard(sceneName);

  if (sceneGuard?.status === "flagged" && sceneGuard.reasons.length > 0) {
    this.update({
      pendingProgramSwitch: {
        sceneName,
        reasons: sceneGuard.reasons,
        requestedFrom,
      },
    });
    return;
  }

  await this.sendProgramScene(sceneName, requestedFrom);
}
```

- [ ] **Step 5: Run the focused scene-guard suite until the dual-loop client behavior passes**

Run: `npm run test:obs-scene-guard`

Expected: PASS

- [ ] **Step 6: Commit the `ObsClient` source-health implementation**

```bash
git add src/lib/obs-client.ts
git commit -m "feat: add OBS source health scene guard loops"
```

### Task 5: Add the Scene-Matrix Warning Affordance and Contract Tests

**Files:**
- Modify: `src/components/ObsPanel.tsx`
- Create: `tests/contract/obs-panel.scene-guard-contract.test.ts`
- Modify: `package.json`
- Test: `tests/contract/obs-panel.scene-guard-contract.test.ts`

- [ ] **Step 1: Add failing contract tests for the new warning affordance and reason labels**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

test("ObsPanel passes guard state into each scene button", () => {
  const source = readSource("src/components/ObsPanel.tsx");

  assert.match(source, /guardState=\{s\.sceneGuard\[sceneName\]\}/);
});

test("ObsPanel renders a WARN badge for flagged non-program scenes", () => {
  const source = readSource("src/components/ObsPanel.tsx");

  assert.match(source, /label="WARN"/);
  assert.match(source, /const flagged = guardState\?\.status === "flagged"/);
});

test("scene guard reason labels include Frozen source and Laggy source", () => {
  const source = readSource("src/lib/obs-scene-guard.ts");

  assert.match(source, /"Frozen source"/);
  assert.match(source, /"Laggy source"/);
});
```

- [ ] **Step 2: Run the contract file directly to verify it fails before the scene button is updated**

Run: `node --test --experimental-strip-types tests/contract/obs-panel.scene-guard-contract.test.ts`

Expected: FAIL because `ObsPanel.tsx` does not yet pass `guardState` or render a `WARN` badge.

- [ ] **Step 3: Update `ObsPanel.tsx` so flagged scenes show a warning badge without changing the switch flow**

```tsx
{s.scenes.map((sceneName) => (
  <SceneButton
    key={sceneName}
    sceneName={sceneName}
    isProgram={s.currentScene === sceneName}
    isPreview={remoteStudioOn && previewScene === sceneName}
    guardState={s.sceneGuard[sceneName]}
    compact={compactSceneCards}
    onSelect={call(() => obsClient.setScene(sceneName))}
  />
))}

function SceneButton({
  sceneName,
  isProgram,
  isPreview,
  guardState,
  compact,
  onSelect,
}: {
  sceneName: string;
  isProgram: boolean;
  isPreview: boolean;
  guardState?: ObsState["sceneGuard"][string];
  compact: boolean;
  onSelect: () => void;
}) {
  const flagged = guardState?.status === "flagged";

  return (
    <button
      onClick={onSelect}
      className={`btn-tap relative h-full min-h-0 overflow-hidden rounded-xl border text-left transition ${
        compact ? "p-2" : "p-2.5"
      } ${
        isProgram
          ? "border-transparent live-glow"
          : isPreview
            ? "border-[var(--obs)]"
            : flagged
              ? "border-amber-400/80 hover:border-amber-300"
              : "border-border hover:border-foreground/30"
      }`}
      style={{
        background: isProgram
          ? "color-mix(in oklab, var(--live) 20%, var(--card))"
          : isPreview
            ? "color-mix(in oklab, var(--obs) 14%, var(--card))"
            : flagged
              ? "color-mix(in oklab, rgb(245 158 11) 10%, var(--card))"
              : "color-mix(in oklab, var(--card) 80%, transparent)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={`block truncate leading-tight font-semibold ${
            compact ? "text-[11px]" : "text-xs sm:text-sm"
          }`}
        >
          {sceneName}
        </span>
        {isProgram ? (
          <SceneBadge background="var(--live)" color="white" label="LIVE" />
        ) : isPreview ? (
          <SceneBadge
            background="color-mix(in oklab, var(--obs) 30%, transparent)"
            color="var(--obs)"
            label="PREV"
          />
        ) : flagged ? (
          <SceneBadge
            background="rgba(245, 158, 11, 0.18)"
            color="#fbbf24"
            label="WARN"
          />
        ) : null}
      </div>
    </button>
  );
}
```

- [ ] **Step 4: Extend the focused scene-guard script to include the new contract test**

```json
{
  "scripts": {
    "test:obs-scene-guard": "node --test --experimental-strip-types tests/unit/lib/obs-scene-guard.test.ts tests/unit/lib/obs-source-health.test.ts tests/integration/lib/obs-client.remote-studio.test.ts tests/contract/obs-panel.scene-guard-contract.test.ts"
  }
}
```

- [ ] **Step 5: Re-run the focused scene-guard suite until the UI contract passes**

Run: `npm run test:obs-scene-guard`

Expected: PASS

- [ ] **Step 6: Commit the UI warning affordance**

```bash
git add src/components/ObsPanel.tsx tests/contract/obs-panel.scene-guard-contract.test.ts package.json
git commit -m "feat: surface OBS source health warnings in the scene matrix"
```

### Task 6: Final Verification

**Files:**
- Modify: none
- Test: `tests/unit/lib/obs-scene-guard.test.ts`
- Test: `tests/unit/lib/obs-source-health.test.ts`
- Test: `tests/integration/lib/obs-client.remote-studio.test.ts`
- Test: `tests/contract/obs-panel.scene-guard-contract.test.ts`

- [ ] **Step 1: Run the full unit suite**

Run: `npm run test:unit`

Expected: PASS

- [ ] **Step 2: Run the full integration suite**

Run: `npm run test:integration`

Expected: PASS

- [ ] **Step 3: Run the full contract suite**

Run: `npm run test:contract`

Expected: PASS

- [ ] **Step 4: Run the focused scene-guard suite as the final regression target**

Run: `npm run test:obs-scene-guard`

Expected: PASS

- [ ] **Step 5: Build the app**

Run: `npm run build`

Expected: PASS

- [ ] **Step 6: Lint the app**

Run: `npm run lint`

Expected: PASS

- [ ] **Step 7: Commit the verification checkpoint**

```bash
git add src/lib/obs-scene-guard.ts src/lib/obs-source-health.ts src/lib/obs-client.ts src/components/ObsPanel.tsx tests/unit/lib/obs-scene-guard.test.ts tests/unit/lib/obs-source-health.test.ts tests/integration/lib/obs-client.remote-studio.test.ts tests/contract/obs-panel.scene-guard-contract.test.ts package.json
git commit -m "chore: verify OBS source health scene guard"
```

## Self-Review

### Spec Coverage

- Image heuristics remain only for black and fallback: Task 1 preserves and narrows the pure image guard.
- Freeze/lag move to source health: Tasks 2 and 4 add source selection and source-health probing.
- Each scene resolves its own source instance: Tasks 2 through 4 add `pickPrimarySceneSource()` and `resolvePrimarySource()`.
- Switching stays synchronous against cached state: Task 4 updates `getEffectiveSceneGuard()` and `requestProgramScene()`.
- `30 ms` remains best effort, not guaranteed: Task 4 uses a fast source-health loop plus batch requests, while Task 3 and Task 4 enforce staleness downgrade instead of blocking.
- Existing operator dialog flow remains intact: Task 5 keeps `pendingProgramSwitch` and only adds a scene-matrix warning affordance.

No spec gaps found.

### Placeholder Scan

- No `TBD`, `TODO`, or "implement later" placeholders remain.
- All code-changing steps contain explicit code blocks.
- Every test and verification step has an exact command and expected outcome.

### Type Consistency

- `SceneGuardReason`, `SourceHealthGuardState`, `ScenePrimarySource`, `applySourceHealthProbe()`, and `getEffectiveSceneGuard()` are named consistently across tasks.
- The final reason set is always `fullBlack`, `possibleTransmitterFallback`, `frozenSource`, and `laggySource`.
- The plan consistently treats `SceneGuardState` as the composed result of `image` plus `sourceHealth`.
