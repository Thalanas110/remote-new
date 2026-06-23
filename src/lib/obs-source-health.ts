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
    status:
      reasons.length > 0 ? "flagged" : sample.probeOk ? "healthy" : "unknown",
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
