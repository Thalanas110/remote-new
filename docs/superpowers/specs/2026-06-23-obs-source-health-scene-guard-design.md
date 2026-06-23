# OBS Source-Health Scene Guard Design

Date: 2026-06-23

## Summary

The OBS scene guard should stop using frame-stability heuristics to detect frozen or laggy cameras. It should keep screenshot-based detection only for obvious visual fault states such as full black output and possible transmitter fallback screens. Freeze and lag detection should move to source-health probing that treats each scene's primary camera or browser source as the unit of health.

The operator workflow stays the same:

- continuously monitor scenes in the background
- keep switching real-time by reading only cached guard state
- warn before a flagged scene reaches program
- allow `unknown` scenes through without blocking

## Problem

The current scene guard uses repeated low-resolution screenshots and frame-fingerprint comparisons to infer frozen output. That creates the wrong tradeoff for live cameras:

- false positives when a person or shot holds still
- false negatives when a source remains visually similar but is actually unhealthy
- no explicit separation between scene-image faults and source-health faults

This is especially problematic for the current input mix:

- `Video Capture Device`
- `Browser Source`

Each scene uses its own separate camera or browser source instance, so scene-level health must be resolved from the specific source embedded in that scene rather than from a shared reusable camera source.

## Goals

- Keep screenshot heuristics for `fullBlack` and `possibleTransmitterFallback`.
- Remove screenshot fingerprint stability as the signal for frozen or laggy cameras.
- Detect freeze and lag from source-health evidence instead of static-image similarity.
- Keep the existing confirmation-before-live workflow.
- Keep scene switching synchronous and real-time by consulting only cached state.
- Minimize both false positives and false negatives as far as OBS/browser telemetry allows.
- Treat a visually still person as healthy when OBS/source health is normal.

## Non-Goals

- Perfect detection of all capture-device freezes using only stock OBS telemetry.
- Hard guaranteeing `30 ms` maximum freshness for every scene in a browser `obs-websocket` client.
- Changing the operator-facing scene-switch flow.
- Replacing the existing program monitor feature.
- Removing the current screenshot path for black/fallback detection.
- Introducing a mandatory external proxy pipeline in the first iteration.

## Agreed Behavior

### Detection Split

- `fullBlack` stays screenshot-based.
- `possibleTransmitterFallback` stays screenshot-based.
- `frozenSource` becomes source-health based.
- `laggySource` becomes source-health based.

### Freeze Interpretation

A source must not be marked frozen merely because the image looks unchanged. If a person stands still for several seconds and OBS still renders the source normally with no health issues, the guard should treat the scene as healthy.

### Freshness Interpretation

The desired freshness target is approximately `30 ms`, but this must be treated as a best-effort target rather than a hard guarantee. The browser client cannot reliably promise per-scene source-health freshness at that bound across multiple scenes. When data is too old to trust, the scene should degrade to `unknown` instead of blocking a switch.

## Approach Options Considered

### Option 1: OBS Stats Only

Use only `GetStats`, source active/show state, and similar OBS-native signals for all detection.

Pros:

- removes still-frame false positives
- simple model

Cons:

- weak per-source fidelity
- poor coverage for browser-source-specific failure modes
- does not preserve working image-based detection for obvious black/fallback states

### Option 2: Hybrid Source Health Plus Existing Image Heuristics

Keep image heuristics for black/fallback conditions and replace screenshot-based frozen/laggy detection with source-health detection for each scene's primary source.

Pros:

- directly addresses the current false-positive/false-negative problem
- preserves the parts of the current system that are still useful
- fits the existing `ObsClient` architecture and operator flow

Cons:

- still limited by what OBS exposes for capture-device health
- `30 ms` freshness remains best effort

### Option 3: Instrumented Or Proxied Sources

Add explicit health telemetry to browser sources and eventually proxy camera feeds through a pipeline with its own heartbeat and buffering metrics.

Pros:

- highest long-term accuracy ceiling

Cons:

- broader system change
- more operational complexity

### Recommendation

Use Option 2 now. It corrects the current detection model without expanding scope into mandatory proxies or external services. Leave room in the design for future browser-source heartbeat instrumentation and optional proxy-based health signals.

## Architecture

The scene guard remains the agent and orchestrator. It continues to own:

- continuous background monitoring
- cached per-scene health
- program-switch gating
- pending confirmation flow

The major change is the internal split between:

- scene-image fault detection
- source-health fault detection

### Scene-Image Detection Path

This path remains low-resolution screenshot analysis and is used only for:

- `fullBlack`
- `possibleTransmitterFallback`

It should continue to use the existing small-image path and browser-side pixel analysis because those conditions are visual and the current approach is appropriate for them.

### Source-Health Detection Path

This path replaces unchanged-frame fingerprint logic for camera freeze/lag detection. It should operate on a resolved primary source for each scene and classify:

- `frozenSource`
- `laggySource`

It should use corroborated health evidence instead of a single signal.

## Scene-To-Source Resolution

Because each scene has its own separate camera or browser source instance, the guard should resolve a primary monitored source for each scene.

### Resolution Rules

- Inspect scene items for each scene.
- Identify candidate visible video-bearing inputs.
- Prefer `Video Capture Device` and `Browser Source` candidates.
- If multiple candidates exist, choose one deterministic primary source.
- Cache the resolved source identity per scene.

For the first iteration, deterministic primary-source selection is acceptable even if a scene contains multiple relevant video sources. The design should keep the resolution logic isolated so multi-source health can be added later without rewriting the guard.

### Suggested Priority

Choose the first matching visible scene item according to a stable priority:

1. enabled visible `Video Capture Device`
2. enabled visible `Browser Source`
3. other enabled visible video input

If no suitable source can be resolved, the source-health path for that scene becomes `unknown` and the guard relies only on the scene-image path.

## Detection Model

The guard should split reasons into four operator-facing buckets:

- `fullBlack`
- `possibleTransmitterFallback`
- `frozenSource`
- `laggySource`

### Full Black

No change in core design. Continue using low-resolution scene screenshots and conservative thresholds.

### Possible Transmitter Fallback

No change in core design. Continue using low-resolution scene screenshots and visual heuristics tuned for the known fallback screen pattern.

### Frozen Source

`frozenSource` must be driven by source-health evidence, not visual sameness.

Evidence that can contribute:

- repeated failure to probe or render the scene/source during health checks
- repeated OBS indication that the source is not active or not showing when it should be
- persistent probe timeouts
- a run of failed health checks without recovery

Evidence that must not contribute by itself:

- an unchanged-looking frame

### Laggy Source

`laggySource` should represent a source that still renders but is unstable, delayed, or repeatedly slow.

Evidence that can contribute:

- repeated probe latency above threshold
- repeated slow screenshot/probe responses
- OBS render-stress deltas during probing
- repeated intermittent source-health failures followed by recovery

Laggy classification should require sustained evidence rather than a single slow sample.

## Evidence Sources

The source-health path should use corroborated evidence from multiple lightweight probes.

### Required Evidence Inputs

- probe success/failure for lightweight scene or source rendering checks
- probe latency measurement
- `InputActiveStateChanged`
- `InputShowStateChanged`
- `GetSourceActive`
- `GetStats` deltas such as render skipped frames and frame render time around probe windows

### Future Optional Evidence

- browser-source heartbeat or vendor telemetry when the browser content is under our control
- proxy or transport health for sources that eventually move behind a dedicated media pipeline

## State Model

The current simple scene guard cache should be expanded into combined scene-image and source-health state.

Suggested structure:

```ts
type SceneGuardReason =
  | "fullBlack"
  | "possibleTransmitterFallback"
  | "frozenSource"
  | "laggySource";

type SceneGuardStatus = "healthy" | "flagged" | "unknown";

type SceneImageGuardState = {
  status: SceneGuardStatus;
  reasons: Array<Extract<SceneGuardReason, "fullBlack" | "possibleTransmitterFallback">>;
  lastCheckedAt: number | null;
};

type SourceHealthGuardState = {
  status: SceneGuardStatus;
  reasons: Array<Extract<SceneGuardReason, "frozenSource" | "laggySource">>;
  sourceName: string | null;
  sourceKind: string | null;
  lastCheckedAt: number | null;
  lastHealthyAt: number | null;
  lastProbeLatencyMs: number | null;
  consecutiveFailures: number;
  consecutiveSlowProbes: number;
};

type SceneGuardState = {
  status: SceneGuardStatus;
  reasons: SceneGuardReason[];
  image: SceneImageGuardState;
  sourceHealth: SourceHealthGuardState;
};
```

### State Rules

- each scene starts as `unknown`
- final scene status is derived from image plus source-health state
- any positive reason marks the scene `flagged`
- a scene is `healthy` only when the currently trusted evidence says no reason applies
- stale or unresolved evidence degrades to `unknown`
- `unknown` never blocks switching

## Scheduling Model

The guard should stop relying on a single scene-screenshot loop for all detection. It should split into two asynchronous loops.

### Scene-Image Loop

Responsibilities:

- run screenshot analysis for `fullBlack`
- run screenshot analysis for `possibleTransmitterFallback`

Behavior:

- round-robin across scenes
- low-resolution image fetches
- lower frequency than the source-health loop
- independent from switch-time actions

### Source-Health Loop

Responsibilities:

- resolve or refresh primary scene source metadata
- run fast best-effort source-health probing
- update `frozenSource` and `laggySource`

Behavior:

- operate continuously and asynchronously
- prefer tighter cadence than the scene-image loop
- maintain rolling evidence counters rather than single-sample decisions
- degrade to `unknown` when health data is stale

### Switch-Time Rule

Program switching must never wait for a fresh probe. It reads only cached state synchronously.

If the cached source-health entry for the target scene is:

- `flagged`: prompt for confirmation
- `healthy`: switch immediately
- `unknown`: switch immediately

## Classification Policy

The classifier should require corroborated evidence for `frozenSource` and `laggySource`.

### Frozen Source Policy

Flag when strong evidence shows the primary source is stalled or failing, such as:

- repeated probe failures
- repeated timeouts
- repeated inactive/not-showing state inconsistent with expected visibility

Do not flag from static appearance alone.

### Laggy Source Policy

Flag when the source repeatedly renders slowly or causes repeated render stress during health checks.

This should be based on:

- rolling latency threshold breaches
- repeated elevated render-time or skipped-frame deltas
- intermittent degraded probe behavior

One slow probe is not enough.

### Unknown Policy

Return `unknown` when:

- the source cannot be resolved
- probe results are stale
- evidence is weak or conflicting
- OBS requests fail in a way that prevents confidence

`Unknown` must stay non-blocking.

## UI Behavior

The operator-facing flow should remain compact and familiar.

### Scene Matrix

Continue to show lightweight warning affordances on flagged scenes. The warning label should reflect the new reason set:

- `Full black`
- `Possible transmitter fallback screen`
- `Frozen source`
- `Laggy source`

### Confirmation Dialog

Keep the existing confirm-before-live flow. The dialog should list the exact reasons from the new reason set and continue to allow:

- `Cancel`
- `Switch anyway`

### Preview Behavior

No change:

- staging a preview scene does not trigger a warning
- warnings apply only when a scene is about to reach program

## Failure Policy

- OBS health-probe failures must not disconnect the client.
- Failures should affect only the relevant scene or source-health entry.
- Scene-image and source-health loops should fail independently.
- A failed source-health probe should not erase valid recent image-based black/fallback state.
- A failed image probe should not erase valid recent source-health state.

## Performance And Practical Limits

- Keep switch-time behavior synchronous against cached state only.
- Keep source-health probes lightweight and bounded.
- Avoid expensive full-size image analysis for freeze/lag.
- Treat `30 ms` as aspirational best effort, not contractual freshness.
- Expect browser-source accuracy to improve further if future heartbeat instrumentation is added.

## Testing Strategy

Implementation must follow TDD.

### Pure Classification Coverage

- still-person scenario remains healthy without source-health faults
- repeated source-health failures flag `frozenSource`
- repeated slow probes flag `laggySource`
- weak evidence stays `unknown`
- combined image and source-health reasons merge correctly

### ObsClient Coverage

- scene-to-source resolution picks the expected primary source
- scene-image and source-health loops update independently
- stale source-health degrades to `unknown`
- a flagged source-health state opens confirmation for live switches
- preview staging remains non-blocking
- `Switch anyway` still sends the original OBS command

### Regression Coverage

- existing `fullBlack` behavior remains intact
- existing transmitter fallback behavior remains intact
- unchanged-frame visual content no longer produces frozen warnings by itself

## Risks And Tradeoffs

- OBS does not provide perfect per-source lag/freeze telemetry for all source kinds.
- Capture-device freezes that still appear healthy to OBS may remain partially undetectable without deeper instrumentation.
- Browser-side `obs-websocket` cannot hard guarantee `30 ms` freshness across all scenes.
- Primary-source resolution can be imperfect in scenes with multiple relevant video inputs.

These tradeoffs are acceptable because the design directly removes the most harmful heuristic while preserving the current operator workflow and leaving room for stronger source telemetry later.

## Implementation Notes

- Keep the guard orchestration in `src/lib/obs-client.ts`.
- Keep image heuristics in `src/lib/obs-scene-guard.ts`.
- Add source-resolution and source-health logic as isolated helpers rather than folding everything into one classifier.
- Preserve the current UI flow in `src/components/ObsPanel.tsx`.
- Remove or disable unchanged-frame fingerprint logic for freeze/lag decisions.
- Keep the design extensible for future browser-source heartbeat support.
