import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultSourceHealthGuardState } from "../../../src/lib/obs-scene-guard.ts";
import {
  applySourceHealthProbe,
  isSourceHealthFresh,
  pickPrimarySceneSource,
} from "../../../src/lib/obs-source-health.ts";

function createProbeSample(
  overrides: Partial<Parameters<typeof applySourceHealthProbe>[2]> = {},
) {
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
