# OBS Scene Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-time OBS scene watchdog that continuously analyzes all scenes, flags suspicious outputs, and asks for confirmation before a flagged scene reaches program.

**Architecture:** Split the work into a pure scene-guard analysis module, a browser-only image decoding helper, and an `ObsClient` watchdog/gating layer that owns per-scene state plus pending-switch confirmation. Keep `ObsPanel` passive by reading `sceneGuard` and `pendingProgramSwitch` from client state, showing lightweight scene warnings plus a confirmation dialog for flagged switches.

**Tech Stack:** React 19, TanStack Start, TypeScript, obs-websocket-js, Node built-in test runner, Radix Alert Dialog

---

## File Structure

- Create: `src/lib/obs-scene-guard.ts`
  Purpose: define scene-guard types, thresholds, pure pixel-analysis helpers, classification logic, freshness checks, and user-facing reason formatting.
- Create: `src/lib/obs-scene-guard.browser.ts`
  Purpose: decode screenshot data URLs into pixel buffers in the browser and feed them into the pure analysis helpers.
- Create: `src/lib/obs-scene-guard.test.ts`
  Purpose: cover the pure guard-analysis rules with fast unit tests that do not depend on OBS or the DOM.
- Modify: `src/lib/obs-client.ts`
  Purpose: add `sceneGuard` and `pendingProgramSwitch` state, reconcile scene caches, run the serial watchdog, and gate program switches against fresh flagged results.
- Modify: `src/lib/obs-client.remote-studio.test.ts`
  Purpose: extend the focused OBS client regression tests to cover watchdog passes, guarded direct cuts, guarded transitions, and confirm/cancel switch flows.
- Create: `src/obs.scene-guard.contract.test.ts`
  Purpose: source-contract test the `ObsPanel` warning UI wiring and dialog copy without introducing a browser test runner.
- Modify: `src/components/ObsPanel.tsx`
  Purpose: render scene warning markers, surface guard reasons, and show the pending-switch confirmation dialog using existing alert-dialog primitives.
- Modify: `package.json`
  Purpose: add a focused `test:obs-scene-guard` script that runs the new guard helper, client, and UI contract tests together.

### Task 1: Add Pure Scene Guard Tests

**Files:**
- Create: `src/lib/obs-scene-guard.test.ts`
- Test: `src/lib/obs-scene-guard.test.ts`

- [ ] **Step 1: Create failing unit tests for black detection, frozen detection, transmitter heuristics, freshness, and reason formatting**

```ts
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

  assert.equal(isSceneGuardFresh(stale, 20_000), false);
  assert.equal(isSceneGuardFresh(stale, 5_000), true);
});

test("formatSceneGuardReason returns operator-facing labels", () => {
  assert.equal(formatSceneGuardReason("fullBlack"), "Full black");
  assert.equal(formatSceneGuardReason("frozen"), "Frozen");
  assert.equal(
    formatSceneGuardReason("possibleTransmitterFallback"),
    "Possible transmitter fallback screen",
  );
});
```

- [ ] **Step 2: Run the new unit test file to verify it fails because the guard module does not exist yet**

Run: `node --test --experimental-strip-types src/lib/obs-scene-guard.test.ts`

Expected: FAIL with module-resolution or export errors for `src/lib/obs-scene-guard.ts`.

- [ ] **Step 3: Commit the red test file**

```bash
git add src/lib/obs-scene-guard.test.ts
git commit -m "test: add scene guard analysis coverage"
```

### Task 2: Implement the Pure Scene Guard Module

**Files:**
- Create: `src/lib/obs-scene-guard.ts`
- Test: `src/lib/obs-scene-guard.test.ts`

- [ ] **Step 1: Add the shared scene-guard types, constants, and default-state helpers**

```ts
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
  if (!sceneGuard?.lastCheckedAt) {
    return false;
  }

  return now - sceneGuard.lastCheckedAt <= SCENE_GUARD_STALE_MS;
}
```

- [ ] **Step 2: Add pure pixel-analysis helpers that produce a tiny fingerprint plus the black/transmitter metrics**

```ts
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

function buildFingerprint(data: Uint8ClampedArray, width: number, height: number) {
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

  const average = cells.reduce((sum, value) => sum + value, 0) / cells.length;
  return cells.map((value) => (value >= average ? "1" : "0")).join("");
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

  const topBand = readAverageBandLuma(data, width, 0, Math.max(1, Math.floor(height / 6)));
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
```

- [ ] **Step 3: Add classification logic that keeps unknown states non-blocking and flags only positive detections**

```ts
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
```

- [ ] **Step 4: Re-run the pure guard tests until they pass**

Run: `node --test --experimental-strip-types src/lib/obs-scene-guard.test.ts`

Expected: PASS with all pure analysis/classification tests green.

- [ ] **Step 5: Commit the pure guard module**

```bash
git add src/lib/obs-scene-guard.ts src/lib/obs-scene-guard.test.ts
git commit -m "feat: add pure OBS scene guard analysis"
```

### Task 3: Add Failing ObsClient Guard Tests

**Files:**
- Modify: `src/lib/obs-client.remote-studio.test.ts`
- Modify: `package.json`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Expand the fake OBS transport so screenshot responses can vary by scene name**

```ts
type FakeObs = {
  calls: CallRecord[];
  responses: Map<string, unknown>;
  screenshotResponses: Map<string, unknown>;
  handlers: Map<string, (payload: any) => void>;
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
  ]),
  handlers: new Map(),
  async call(method, args) {
    this.calls.push({ method, args });

    if (method === "GetSourceScreenshot") {
      const sceneName = String(args?.sourceName ?? "");
      const response = this.screenshotResponses.get(sceneName);
      if (response instanceof Error) {
        throw response;
      }
      return response ?? { imageData: "ZmFsbGJhY2s=" };
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

- [ ] **Step 2: Instantiate `ObsClient` with fake analysis helpers so watchdog passes stay deterministic in tests**

```ts
function createClient() {
  let now = 1_000;
  const analysisByImage = new Map<string, SceneGuardMetrics>([
    [
      "data:image/jpeg;base64,c2NlbmUtYQ==",
      {
        averageLuma: 80,
        blackPixelRatio: 0.04,
        fingerprint: "0101010101010101",
        transmitterScore: 0.05,
      },
    ],
    [
      "data:image/jpeg;base64,c2NlbmUtYg==",
      {
        averageLuma: 80,
        blackPixelRatio: 0.04,
        fingerprint: "1111000011110000",
        transmitterScore: 0.05,
      },
    ],
  ]);

  const client = new ObsClient({
    analyzeSceneGuardImageDataUrl: async (imageDataUrl) => {
      const metrics = analysisByImage.get(imageDataUrl);
      if (!metrics) {
        throw new Error(`No fake metrics for ${imageDataUrl}`);
      }
      return metrics;
    },
    now: () => now,
  });

  client.obs = fakeObs as never;
  client.state = {
    connected: true,
    currentScene: "Scene A",
    scenes: ["Scene A", "Scene B"],
    remoteStudioMode: false,
    remotePreviewScene: "Scene A",
    programMonitor: {
      imageDataUrl: null,
      loading: false,
      error: undefined,
      lastUpdatedAt: null,
    },
    sceneGuard: {},
    pendingProgramSwitch: null,
    streaming: false,
    recording: false,
    recordPaused: false,
    virtualCam: false,
  } as never;

  return {
    client,
    fakeObs,
    analysisByImage,
    advanceTime: (ms: number) => {
      now += ms;
    },
  };
}
```

- [ ] **Step 3: Add failing client tests for the watchdog cache and guarded switching flow**

```ts
test("refreshAll seeds new scene guard entries as unknown", async () => {
  const { client } = createClient();

  await client.refreshAll();

  assert.equal(client.state.sceneGuard["Scene A"]?.status, "unknown");
  assert.equal(client.state.sceneGuard["Scene B"]?.status, "unknown");
});

test("a scene guard pass marks a full-black scene as flagged", async () => {
  const { client, analysisByImage } = createClient();

  analysisByImage.set("data:image/jpeg;base64,c2NlbmUtYQ==", {
    averageLuma: 0,
    blackPixelRatio: 1,
    fingerprint: "0000000000000000",
    transmitterScore: 0.02,
  });

  await client.refreshAll();
  await (client as any).runSceneGuardPass();

  assert.deepEqual(client.state.sceneGuard["Scene A"], {
    status: "flagged",
    reasons: ["fullBlack"],
    lastCheckedAt: 1_000,
    lastFingerprint: "0000000000000000",
    unchangedCount: 1,
  });
});

test("three unchanged passes flag a scene as frozen", async () => {
  const { client, fakeObs } = createClient();

  fakeObs.responses.set("GetSceneList", {
    scenes: [{ sceneName: "Scene A" }],
    currentProgramSceneName: "Scene A",
  });

  await client.refreshAll();
  await (client as any).runSceneGuardPass();
  await (client as any).runSceneGuardPass();
  await (client as any).runSceneGuardPass();

  assert.deepEqual(client.state.sceneGuard["Scene A"]?.reasons, ["frozen"]);
});

test("setScene stores a pending confirmation instead of hard-cutting a flagged scene", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  client.state.sceneGuard["Scene B"] = {
    status: "flagged",
    reasons: ["frozen"],
    lastCheckedAt: 1_000,
    lastFingerprint: "1111000011110000",
    unchangedCount: 3,
  };
  advanceTime(1_000);

  await client.setScene("Scene B");

  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetCurrentProgramScene"),
    [],
  );
  assert.deepEqual(client.state.pendingProgramSwitch, {
    sceneName: "Scene B",
    reasons: ["frozen"],
    requestedFrom: "directCut",
  });
});

test("confirmPendingProgramSwitch sends the deferred OBS switch", async () => {
  const { client, fakeObs } = createClient();

  client.state.pendingProgramSwitch = {
    sceneName: "Scene B",
    reasons: ["fullBlack"],
    requestedFrom: "directCut",
  } as never;

  await client.confirmPendingProgramSwitch();

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
  assert.equal(client.state.pendingProgramSwitch, null);
});

test("cancelPendingProgramSwitch clears the pending scene without switching", () => {
  const { client, fakeObs } = createClient();

  client.state.pendingProgramSwitch = {
    sceneName: "Scene B",
    reasons: ["possibleTransmitterFallback"],
    requestedFrom: "transition",
  } as never;

  client.cancelPendingProgramSwitch();

  assert.equal(client.state.pendingProgramSwitch, null);
  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetCurrentProgramScene"),
    [],
  );
});

test("triggerTransition opens confirmation when the staged preview is flagged", async () => {
  const { client, fakeObs, advanceTime } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");
  client.state.sceneGuard["Scene B"] = {
    status: "flagged",
    reasons: ["possibleTransmitterFallback"],
    lastCheckedAt: 1_000,
    lastFingerprint: "1111000011110000",
    unchangedCount: 1,
  };
  advanceTime(1_000);

  await client.triggerTransition();

  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetCurrentProgramScene"),
    [],
  );
  assert.deepEqual(client.state.pendingProgramSwitch, {
    sceneName: "Scene B",
    reasons: ["possibleTransmitterFallback"],
    requestedFrom: "transition",
  });
});
```

- [ ] **Step 4: Add a focused package script for the new guard test suite**

```json
{
  "scripts": {
    "dev": "vite --configLoader runner --port 5173 --strictPort",
    "build": "vite build --configLoader runner",
    "build:dev": "vite build --mode development --configLoader runner",
    "preview": "vite preview --configLoader runner",
    "test:obs-remote-studio": "node --test --experimental-strip-types src/lib/obs-client.remote-studio.test.ts",
    "test:obs-scene-guard": "node --test --experimental-strip-types src/lib/obs-scene-guard.test.ts src/lib/obs-client.remote-studio.test.ts",
    "lint": "eslint .",
    "format": "prettier --write ."
  }
}
```

- [ ] **Step 5: Run the focused guard test script to verify the new client coverage fails for the expected reasons**

Run: `npm run test:obs-scene-guard`

Expected: FAIL because `ObsClient` does not yet expose `sceneGuard`, `pendingProgramSwitch`, `runSceneGuardPass()`, or confirm/cancel pending-switch methods.

- [ ] **Step 6: Commit the red client test changes**

```bash
git add package.json src/lib/obs-client.remote-studio.test.ts
git commit -m "test: cover guarded OBS scene switching"
```

### Task 4: Implement Browser Decoding and ObsClient Watchdog State

**Files:**
- Create: `src/lib/obs-scene-guard.browser.ts`
- Modify: `src/lib/obs-client.ts`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Add a browser-only screenshot decoder that reuses one canvas and delegates all metrics to the pure guard module**

```ts
import {
  analyzeSceneGuardPixels,
  type SceneGuardMetrics,
} from "./obs-scene-guard.ts";

let analysisCanvas: HTMLCanvasElement | null = null;
let analysisContext: CanvasRenderingContext2D | null = null;

function loadImage(imageDataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode scene guard screenshot"));
    image.src = imageDataUrl;
  });
}

function getAnalysisContext() {
  if (!analysisCanvas) {
    analysisCanvas = document.createElement("canvas");
    analysisContext = analysisCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }

  if (!analysisCanvas || !analysisContext) {
    throw new Error("Scene guard analysis context unavailable");
  }

  return { canvas: analysisCanvas, context: analysisContext };
}

export async function analyzeSceneGuardImageDataUrl(
  imageDataUrl: string,
): Promise<SceneGuardMetrics> {
  const image = await loadImage(imageDataUrl);
  const { canvas, context } = getAnalysisContext();

  canvas.width = image.width;
  canvas.height = image.height;
  context.clearRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);

  const { data } = context.getImageData(0, 0, image.width, image.height);
  return analyzeSceneGuardPixels({
    data,
    width: image.width,
    height: image.height,
  });
}
```

- [ ] **Step 2: Extend `ObsState` with scene-guard and pending-switch state, then import the new guard helpers into `ObsClient`**

```ts
import {
  SCENE_GUARD_ANALYSIS_FORMAT,
  SCENE_GUARD_ANALYSIS_QUALITY,
  SCENE_GUARD_ANALYSIS_WIDTH,
  createDefaultSceneGuardState,
  classifySceneGuardSample,
  isSceneGuardFresh,
  type SceneGuardMetrics,
  type SceneGuardReason,
  type SceneGuardState,
} from "./obs-scene-guard.ts";
import { analyzeSceneGuardImageDataUrl } from "./obs-scene-guard.browser.ts";

export type PendingProgramSwitch = {
  sceneName: string;
  reasons: SceneGuardReason[];
  requestedFrom: "directCut" | "transition";
};

export type ObsState = {
  connected: boolean;
  currentScene: string | null;
  scenes: string[];
  remoteStudioMode: boolean;
  remotePreviewScene: string | null;
  programMonitor: ObsProgramMonitorState;
  sceneGuard: Record<string, SceneGuardState>;
  pendingProgramSwitch: PendingProgramSwitch | null;
  streaming: boolean;
  recording: boolean;
  recordPaused: boolean;
  virtualCam: boolean;
  error?: string;
};

type ObsClientDeps = {
  analyzeSceneGuardImageDataUrl?: (imageDataUrl: string) => Promise<SceneGuardMetrics>;
  now?: () => number;
};

function createDefaultObsState(): ObsState {
  return {
    connected: false,
    currentScene: null,
    scenes: [],
    remoteStudioMode: false,
    remotePreviewScene: null,
    programMonitor: createDefaultProgramMonitorState(),
    sceneGuard: {},
    pendingProgramSwitch: null,
    streaming: false,
    recording: false,
    recordPaused: false,
    virtualCam: false,
  };
}
```

- [ ] **Step 3: Add scene-cache reconciliation plus a single-pass watchdog runner that analyzes exactly one scene per pass**

```ts
export class ObsClient {
  obs = new OBSWebSocket();
  private listeners = new Set<(s: ObsState) => void>();
  private programMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorRefreshInFlight: Promise<void> | null = null;
  private sceneGuardTimer: ReturnType<typeof setTimeout> | null = null;
  private sceneGuardPassInFlight: Promise<void> | null = null;
  private nextSceneGuardIndex = 0;
  private readonly analyzeSceneGuardImageDataUrl;
  private readonly now;
  state: ObsState = createDefaultObsState();

  constructor(deps: ObsClientDeps = {}) {
    this.analyzeSceneGuardImageDataUrl =
      deps.analyzeSceneGuardImageDataUrl ?? analyzeSceneGuardImageDataUrl;
    this.now = deps.now ?? Date.now;
  }

  private reconcileSceneGuard(sceneNames: string[]) {
    const nextSceneGuard: Record<string, SceneGuardState> = {};

    for (const sceneName of sceneNames) {
      nextSceneGuard[sceneName] =
        this.state.sceneGuard[sceneName] ?? createDefaultSceneGuardState();
    }

    this.nextSceneGuardIndex =
      sceneNames.length === 0
        ? 0
        : Math.min(this.nextSceneGuardIndex, sceneNames.length - 1);

    this.update({
      scenes: sceneNames,
      sceneGuard: nextSceneGuard,
    });
  }

  private scheduleSceneGuardPass() {
    if (this.sceneGuardTimer || !this.state.connected || this.state.scenes.length === 0) {
      return;
    }

    this.sceneGuardTimer = setTimeout(() => {
      this.sceneGuardTimer = null;
      void this.runSceneGuardPass();
    }, 0);
  }

  private stopSceneGuardWatchdog() {
    if (!this.sceneGuardTimer) {
      return;
    }

    clearTimeout(this.sceneGuardTimer);
    this.sceneGuardTimer = null;
  }

  private async runSceneGuardPass() {
    if (!this.state.connected || this.state.scenes.length === 0) {
      return;
    }

    if (this.sceneGuardPassInFlight) {
      return this.sceneGuardPassInFlight;
    }

    const sceneName = this.state.scenes[this.nextSceneGuardIndex];

    this.sceneGuardPassInFlight = (async () => {
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
          this.state.sceneGuard[sceneName] ?? createDefaultSceneGuardState();

        this.update({
          sceneGuard: {
            ...this.state.sceneGuard,
            [sceneName]: classifySceneGuardSample(previous, metrics, this.now()),
          },
        });
      } catch {
        this.update({
          sceneGuard: {
            ...this.state.sceneGuard,
            [sceneName]: createDefaultSceneGuardState(),
          },
        });
      } finally {
        this.sceneGuardPassInFlight = null;
        this.nextSceneGuardIndex =
          this.state.scenes.length === 0
            ? 0
            : (this.nextSceneGuardIndex + 1) % this.state.scenes.length;
        this.scheduleSceneGuardPass();
      }
    })();

    return this.sceneGuardPassInFlight;
  }
}
```

- [ ] **Step 4: Start and stop the watchdog with the existing OBS lifecycle, and seed the cache whenever scene lists refresh**

```ts
async connect(config: ObsConfig) {
  try {
    this.stopProgramMonitorPolling();
    this.stopSceneGuardWatchdog();
    await this.obs.disconnect().catch(() => {});
    await this.obs.connect(config.url, config.password || undefined);
    this.bindEvents();
    await this.refreshAll();
    this.update({ connected: true, error: undefined });
    await this.refreshProgramMonitor();
    this.startProgramMonitorPolling();
    this.scheduleSceneGuardPass();
  } catch (e: any) {
    this.stopProgramMonitorPolling();
    this.stopSceneGuardWatchdog();
    this.monitorRefreshInFlight = null;
    this.sceneGuardPassInFlight = null;
    this.update({
      connected: false,
      error: e?.message ?? "Failed to connect",
      programMonitor: createDefaultProgramMonitorState(),
      sceneGuard: {},
      pendingProgramSwitch: null,
    });
    throw e;
  }
}

async disconnect() {
  this.stopProgramMonitorPolling();
  this.stopSceneGuardWatchdog();
  this.monitorRefreshInFlight = null;
  this.sceneGuardPassInFlight = null;
  await this.obs.disconnect().catch(() => {});
  this.update(createDefaultObsState());
}

private bindEvents() {
  this.obs.off("SceneListChanged" as any);
  this.obs.on("SceneListChanged", (d: any) => {
    this.reconcileSceneGuard(d.scenes.map((scene: any) => scene.sceneName).reverse());
    this.scheduleSceneGuardPass();
  });
  this.obs.on("ConnectionClosed", () => {
    this.stopProgramMonitorPolling();
    this.stopSceneGuardWatchdog();
    this.monitorRefreshInFlight = null;
    this.sceneGuardPassInFlight = null;
    this.update({
      connected: false,
      programMonitor: createDefaultProgramMonitorState(),
      sceneGuard: {},
      pendingProgramSwitch: null,
    });
  });
}

async refreshAll() {
  const sceneList: any = await this.obs.call("GetSceneList");
  const stream: any = await this.obs.call("GetStreamStatus");
  const record: any = await this.obs.call("GetRecordStatus");
  let vcam = false;
  try {
    const virtualCamStatus: any = await this.obs.call("GetVirtualCamStatus");
    vcam = virtualCamStatus.outputActive;
  } catch {}

  const scenes = sceneList.scenes.map((scene: any) => scene.sceneName).reverse();
  this.reconcileSceneGuard(scenes);
  this.update({
    currentScene: sceneList.currentProgramSceneName,
    remotePreviewScene:
      this.state.remoteStudioMode && this.state.remotePreviewScene
        ? this.state.remotePreviewScene
        : sceneList.currentProgramSceneName,
    streaming: stream.outputActive,
    recording: record.outputActive,
    recordPaused: record.outputPaused,
    virtualCam: vcam,
  });
}
```

- [ ] **Step 5: Re-run the focused guard test suite and iterate until the watchdog-cache tests pass**

Run: `npm run test:obs-scene-guard`

Expected: FAIL only on the pending-switch/UI contract tests that still depend on dialog wiring and guarded switch methods not yet implemented.

- [ ] **Step 6: Commit the watchdog state implementation**

```bash
git add src/lib/obs-scene-guard.browser.ts src/lib/obs-client.ts src/lib/obs-client.remote-studio.test.ts
git commit -m "feat: add OBS scene watchdog state"
```

### Task 5: Gate Program Switches With Pending Confirmation

**Files:**
- Modify: `src/lib/obs-client.ts`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Add fresh-guard lookup and a shared helper for direct cuts and transitions**

```ts
private getFreshSceneGuard(sceneName: string) {
  const sceneGuard = this.state.sceneGuard[sceneName];

  if (!isSceneGuardFresh(sceneGuard, this.now())) {
    return null;
  }

  return sceneGuard;
}

private async sendProgramScene(sceneName: string, requestedFrom: PendingProgramSwitch["requestedFrom"]) {
  await this.obs.call("SetCurrentProgramScene", { sceneName });

  if (requestedFrom === "transition") {
    this.update({ currentScene: sceneName });
    await this.refreshProgramMonitor();
  }
}

private async requestProgramScene(
  sceneName: string,
  requestedFrom: PendingProgramSwitch["requestedFrom"],
) {
  const sceneGuard = this.getFreshSceneGuard(sceneName);

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

- [ ] **Step 2: Route `setScene()` and `triggerTransition()` through the shared guarded switch helper**

```ts
async setScene(name: string) {
  if (this.state.remoteStudioMode) {
    this.update({ remotePreviewScene: name });
    return;
  }

  await this.requestProgramScene(name, "directCut");
}

async triggerTransition() {
  const sceneName = this.state.remotePreviewScene;
  if (!sceneName || sceneName === this.state.currentScene) {
    return;
  }

  await this.requestProgramScene(sceneName, "transition");
}
```

- [ ] **Step 3: Add confirm/cancel methods that the UI can call from the warning dialog**

```ts
async confirmPendingProgramSwitch() {
  const pending = this.state.pendingProgramSwitch;
  if (!pending) {
    return;
  }

  if (!this.state.scenes.includes(pending.sceneName)) {
    this.update({ pendingProgramSwitch: null });
    return;
  }

  this.update({ pendingProgramSwitch: null });
  await this.sendProgramScene(pending.sceneName, pending.requestedFrom);
}

cancelPendingProgramSwitch() {
  this.update({ pendingProgramSwitch: null });
}
```

- [ ] **Step 4: Re-run the focused guard suite until the guarded direct-cut and transition tests pass**

Run: `npm run test:obs-scene-guard`

Expected: FAIL only on the UI contract test, because the scene warning marker and alert dialog are still missing in `ObsPanel.tsx`.

- [ ] **Step 5: Commit the guarded switch flow**

```bash
git add src/lib/obs-client.ts src/lib/obs-client.remote-studio.test.ts
git commit -m "feat: gate flagged OBS scene switches"
```

### Task 6: Add Failing UI Contract Tests For Warning Rendering

**Files:**
- Create: `src/obs.scene-guard.contract.test.ts`
- Modify: `package.json`
- Test: `src/obs.scene-guard.contract.test.ts`

- [ ] **Step 1: Create source-contract tests for warning badges and confirmation-dialog wiring**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

test("OBS panel imports the alert dialog primitives for guarded scene switching", () => {
  const obsPanelSource = readSource("src/components/ObsPanel.tsx");

  assert.match(obsPanelSource, /AlertDialog/);
  assert.match(obsPanelSource, /AlertDialogAction/);
  assert.match(obsPanelSource, /AlertDialogCancel/);
  assert.match(obsPanelSource, /AlertDialogContent/);
  assert.match(obsPanelSource, /AlertDialogDescription/);
  assert.match(obsPanelSource, /AlertDialogTitle/);
});

test("OBS panel exposes the exact scene-guard warning copy", () => {
  const obsPanelSource = readSource("src/components/ObsPanel.tsx");

  assert.match(obsPanelSource, /Switch anyway/);
  assert.match(obsPanelSource, /Full black/);
  assert.match(obsPanelSource, /Frozen/);
  assert.match(obsPanelSource, /Possible transmitter fallback screen/);
});

test("OBS panel wires warning actions back into ObsClient", () => {
  const obsPanelSource = readSource("src/components/ObsPanel.tsx");

  assert.match(obsPanelSource, /obsClient\.confirmPendingProgramSwitch\(\)/);
  assert.match(obsPanelSource, /obsClient\.cancelPendingProgramSwitch\(\)/);
  assert.match(obsPanelSource, /label="WARN"/);
});
```

- [ ] **Step 2: Extend the focused package script so it also runs the new UI contract file**

```json
{
  "scripts": {
    "test:obs-scene-guard": "node --test --experimental-strip-types src/lib/obs-scene-guard.test.ts src/lib/obs-client.remote-studio.test.ts src/obs.scene-guard.contract.test.ts"
  }
}
```

- [ ] **Step 3: Run the focused guard test suite to verify the new contract file fails before the panel is updated**

Run: `npm run test:obs-scene-guard`

Expected: FAIL because `ObsPanel.tsx` does not yet render the warning dialog or `WARN` marker.

- [ ] **Step 4: Commit the red UI contract test**

```bash
git add package.json src/obs.scene-guard.contract.test.ts
git commit -m "test: add OBS scene guard UI contract"
```

### Task 7: Render Scene Warnings And The Confirmation Dialog

**Files:**
- Modify: `src/components/ObsPanel.tsx`
- Test: `src/obs.scene-guard.contract.test.ts`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Import the alert dialog primitives plus the reason formatter, then derive the pending-switch state from `ObsState`**

```tsx
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatSceneGuardReason } from "@/lib/obs-scene-guard";
import { obsClient, type ObsState, defaultObsState } from "@/lib/obs-client";

export function ObsPanel() {
  const [s, setS] = useState<ObsState>(defaultObsState);
  const pendingSwitch = s.pendingProgramSwitch;
```

- [ ] **Step 2: Pass each scene its guard state and render a visible `WARN` badge for flagged scenes**

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
          className={`block truncate leading-tight font-semibold ${compact ? "text-[11px]" : "text-xs sm:text-sm"}`}
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
          <SceneBadge background="rgba(245, 158, 11, 0.18)" color="#fbbf24" label="WARN" />
        ) : null}
      </div>
    </button>
  );
}
```

- [ ] **Step 3: Render the pending-switch confirmation dialog with exact reason labels and explicit confirm/cancel actions**

```tsx
<AlertDialog open={Boolean(pendingSwitch)}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Switch flagged scene?</AlertDialogTitle>
      <AlertDialogDescription>
        {pendingSwitch
          ? `${pendingSwitch.sceneName} was flagged by the scene guard. You can cancel or switch anyway.`
          : "Scene guard warning"}
      </AlertDialogDescription>
    </AlertDialogHeader>
    {pendingSwitch && (
      <div className="rounded-xl border border-border bg-card/60 p-3 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Reasons
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {pendingSwitch.reasons.map((reason) => (
            <li key={reason}>{formatSceneGuardReason(reason)}</li>
          ))}
        </ul>
      </div>
    )}
    <AlertDialogFooter>
      <AlertDialogCancel onClick={call(() => obsClient.cancelPendingProgramSwitch())}>
        Cancel
      </AlertDialogCancel>
      <AlertDialogAction onClick={call(() => obsClient.confirmPendingProgramSwitch())}>
        Switch anyway
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- [ ] **Step 4: Re-run the focused guard suite until the UI contract and existing client tests are all green**

Run: `npm run test:obs-scene-guard`

Expected: PASS with the pure helper tests, client tests, and UI source-contract test all green.

- [ ] **Step 5: Commit the warning UI**

```bash
git add src/components/ObsPanel.tsx src/obs.scene-guard.contract.test.ts
git commit -m "feat: warn before switching flagged OBS scenes"
```

### Task 8: Final Verification

**Files:**
- Modify: none
- Test: `src/lib/obs-scene-guard.test.ts`
- Test: `src/lib/obs-client.remote-studio.test.ts`
- Test: `src/obs.scene-guard.contract.test.ts`

- [ ] **Step 1: Run the focused guard verification suite**

Run: `npm run test:obs-scene-guard`

Expected: PASS

- [ ] **Step 2: Re-run the pre-existing OBS regression suite directly**

Run: `npm run test:obs-remote-studio`

Expected: PASS

- [ ] **Step 3: Typecheck the app**

Run: `npx tsc -p tsconfig.json --noEmit`

Expected: PASS

- [ ] **Step 4: Build the app for integration verification**

Run: `npm run build`

Expected: PASS with no TypeScript or bundling errors.

- [ ] **Step 5: Commit the final verification checkpoint**

```bash
git add package.json src/lib/obs-scene-guard.ts src/lib/obs-scene-guard.browser.ts src/lib/obs-scene-guard.test.ts src/lib/obs-client.ts src/lib/obs-client.remote-studio.test.ts src/components/ObsPanel.tsx src/obs.scene-guard.contract.test.ts
git commit -m "chore: verify OBS scene guard implementation"
```

## Self-Review

### Spec Coverage

- Continuous all-scenes watchdog: Task 4 adds serial scene passes plus lifecycle scheduling.
- Fast analysis path: Tasks 2 and 4 keep metrics tiny and decode only low-resolution screenshots.
- Real-time switching with cached guard checks only: Task 5 routes direct cuts and transitions through cached-state gating only.
- Confirmation dialog with exact reasons: Task 7 renders exact reason labels from `formatSceneGuardReason()`.
- Unknown or stale analysis stays non-blocking: Tasks 2, 4, and 5 use `unknown` plus freshness checks to avoid blocking uncertain scenes.
- Direct-cut and Remote Studio transition interception: Task 5 covers both flows in one guarded helper and Task 3 tests both.

No spec gaps found.

### Placeholder Scan

- No `TBD`, `TODO`, or “implement later” placeholders remain.
- Every code-changing step includes concrete code snippets.
- Every verification step includes an exact command and expected result.

### Type Consistency

- `SceneGuardReason`, `SceneGuardState`, `PendingProgramSwitch`, `classifySceneGuardSample()`, `confirmPendingProgramSwitch()`, and `cancelPendingProgramSwitch()` use the same names across all tasks.
- `sceneGuard` remains a `Record<string, SceneGuardState>` everywhere in the plan.
