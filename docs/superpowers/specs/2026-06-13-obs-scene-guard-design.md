# OBS Scene Guard Design

Date: 2026-06-13

## Summary

The OBS remote should continuously monitor every OBS scene in the background and require operator confirmation before switching a flagged scene to program. The guard must catch three suspect states:

- full black output
- frozen output
- possible transmitter fallback output

The remote must remain real-time. Scene switches should never wait for on-demand analysis. Instead, the switch flow should read a continuously refreshed per-scene health cache and only interrupt when a scene is already known to be suspicious.

## Problem

The current remote can switch any OBS scene directly to program or stage it into remote-local preview with no quality guardrail. That is risky for camera angles because a target scene may already be unusable for reasons such as:

- the camera path is fully black
- the feed is frozen
- the wireless transmitter is connected to the laptop side but disconnected from the camera side, causing a recognizable fallback screen

Because this is a live remote, the solution cannot pause the switch path to capture multiple frames or run heavy analysis at the moment of transition. Detection must happen continuously ahead of time.

## Goals

- Continuously monitor all OBS scenes, even when they are not live or staged in preview.
- Keep scene switching real-time with no switch-time analysis wait.
- Require confirmation before a flagged scene is switched to program.
- Show the exact reason for a warning.
- Allow switching normally when analysis is unavailable or uncertain.
- Use the fastest practical analysis approach in the browser client.
- Support both current heuristic transmitter-screen detection and future exact reference-image matching.

## Non-Goals

- Perfect computer-vision classification of all bad video states.
- Blocking switches when the app is uncertain.
- Replacing the existing remote-local studio workflow.
- Streaming full-motion previews for every scene.
- Adding server-side image analysis or a second media pipeline.

## Agreed Behavior

### Switch Interception Rules

- If Remote Studio is off, tapping a scene still behaves like a direct cut to program.
- If Remote Studio is on, tapping a scene still stages preview only and never triggers a warning by itself.
- When Remote Studio is on, the `Transition` button is the only action that can move the staged scene to program.
- Any action that would put a scene on program must first check the cached guard status for that target scene.

### Guard Outcomes

- If the target scene is `flagged`, open a confirmation dialog before sending the OBS switch.
- If the target scene is `healthy`, switch immediately.
- If the target scene is `unknown`, switch immediately.

### Warning Reasons

The dialog must list the exact reason or reasons that caused the warning:

- `Full black`
- `Frozen`
- `Possible transmitter fallback screen`

### Failure Policy

- If the app cannot confidently analyze a scene because screenshot capture failed, data is stale, or confidence is too low, the scene becomes `unknown`.
- `Unknown` must never block or slow a switch.

## Runtime Model

The guard should run as a continuous all-scenes watchdog inside `ObsClient`.

### Core Rule

Program switching must never trigger fresh analysis. The switch path should only read cached state synchronously.

### Monitoring Scope

- Monitor every scene returned by the OBS scene list.
- Keep monitoring scenes even if they are not visible in the current viewport, not live, and not staged in preview.
- Prioritize overall freshness for all scenes instead of optimizing only for the current program or preview scene.

### Worker Model

- Use one serial watchdog worker.
- Keep only one analysis screenshot request in flight at a time.
- Run the worker as a self-paced async loop rather than a fixed `setInterval`.
- After each scene analysis completes, immediately continue to the next scene in round-robin order.
- Start the watchdog after OBS connects and the initial scene list is available.
- Stop the watchdog on disconnect.

This minimizes overlapping requests, avoids timer pileups, and keeps switching independent from analysis timing.

## Fast Detection Engine

The watchdog must use the fastest practical browser-side algorithm, optimized for small repeated checks rather than visual fidelity.

### Analysis Screenshots

- Use a separate low-resolution screenshot path for watchdog analysis.
- Keep the existing large program monitor image for the UI.
- Request analysis images at a small fixed size such as `96x54`.
- Use a compressed format such as JPEG to keep payload size low.

### Analysis Strategy

Each sampled frame should be reduced to compact metrics instead of compared as a full image:

- average luminance
- black-pixel ratio
- compact scene fingerprint
- lightweight structural signature for transmitter fallback heuristics

The implementation should avoid:

- full-size image diffs
- expensive pixel-by-pixel comparisons across large frames
- heavy visual-model inference
- switch-time frame sampling

### Detection Rules

#### Full Black

Flag `Full black` when the tiny frame's average luminance is near zero and the black-pixel ratio exceeds a high threshold.

#### Frozen

Frozen detection applies to every OBS scene, including intentionally static scenes. This is an accepted tradeoff.

- Generate a compact fingerprint for each sample.
- Compare that fingerprint against the previous fingerprint for the same scene.
- Increment an `unchangedCount` when the fingerprint is unchanged.
- Flag `Frozen` after 3 unchanged samples in a row for that same scene.
- Reset `unchangedCount` when the fingerprint changes meaningfully.

#### Possible Transmitter Fallback Screen

Phase 1:

- use heuristic structural matching without a reference image
- rely on distinctive signature patterns from the low-resolution frame
- keep confidence conservative so uncertain scenes remain `unknown`

Phase 2:

- when a real screenshot of the transmitter fallback screen becomes available, compute one reference fingerprint
- compare future scene samples against that reference fingerprint for a faster and more reliable exact match

### Performance Constraints

- Reuse one canvas and one drawing context for analysis to reduce allocations.
- Keep per-scene state tiny.
- Decode only the small analysis screenshot for watchdog checks.
- Never block the UI waiting for analysis.

## State Model

`ObsState` should gain a per-scene guard cache keyed by scene name.

Suggested types:

```ts
type SceneGuardReason = "fullBlack" | "frozen" | "possibleTransmitterFallback";

type SceneGuardStatus = "healthy" | "flagged" | "unknown";

type SceneGuardState = {
  status: SceneGuardStatus;
  reasons: SceneGuardReason[];
  lastCheckedAt: number | null;
  lastFingerprint: string | null;
  unchangedCount: number;
};
```

`ObsState` should expose:

```ts
sceneGuard: Record<string, SceneGuardState>;
```

### State Rules

- New scenes start as `unknown`.
- Removed scenes are deleted from the cache.
- A scene becomes `flagged` only on positive detection.
- A scene becomes `healthy` when a fresh sample shows no warning conditions.
- A scene becomes `unknown` when analysis fails, becomes stale, or remains too uncertain to classify.

### Staleness

Guard data should not be trusted indefinitely.

- If a scene has not been checked recently enough, treat it as `unknown` for switch decisions.
- Staleness should affect only the guard state, not the main OBS connection state.

## Scheduler Behavior

The watchdog scheduler should operate independently from the existing program monitor refresh.

### Round-Robin Loop

- Keep an ordered queue of current scenes.
- Analyze scenes one at a time in round-robin order.
- On scene list changes, reconcile the queue and cache without tearing down the client.
- New scenes join the next loop cycle.
- Removed scenes leave the queue and cache immediately.

### Error Handling

- If a screenshot request for one scene fails, mark only that scene as `unknown`.
- Continue to the next scene without interrupting the watchdog.
- Guard analysis failures must not disconnect OBS or interfere with stream, record, or program-monitor features.

## UI Behavior

The UI should make scene risk visible ahead of time while keeping the live switching workflow compact.

### Scene Grid

- Add lightweight guard-state treatment on each scene button.
- `Healthy` scenes keep the current visual treatment.
- `Flagged` scenes show a subtle warning marker.
- `Unknown` scenes remain neutral or use only a very light non-alarming hint.

### Confirmation Dialog

Use the existing alert-dialog primitives for the switch warning.

The dialog should:

- name the target scene
- list all warning reasons for that scene
- explain that the switch is still allowed if the operator confirms
- offer `Cancel` and `Switch anyway`

If the user confirms, send the exact same OBS switch command that would have been sent without the warning.

### Switch Revalidation

If scene state changes while the dialog is open, revalidate the pending target before sending the final switch command. This prevents switching to a scene that no longer exists.

## Interaction With Existing OBS Workflows

### Remote Studio Off

- tapping a scene checks `sceneGuard[targetScene]`
- `flagged` opens confirmation
- `healthy` or `unknown` switches immediately with `SetCurrentProgramScene`

### Remote Studio On

- tapping a scene updates `remotePreviewScene` only
- pressing `Transition` checks `sceneGuard[remotePreviewScene]`
- `flagged` opens confirmation
- `healthy` or `unknown` transitions immediately with `SetCurrentProgramScene`

This preserves the existing remote-local studio design and adds only a guard layer around scene-to-program actions.

## Testing Strategy

Implementation must follow TDD.

### Client Coverage

Minimum test coverage in OBS client tests:

- all scenes join the watchdog rotation
- only one analysis request is in flight at a time
- new scenes start as `unknown`
- removed scenes leave the guard cache
- full-black detection flags correctly from tiny screenshots
- frozen detection flags after 3 unchanged samples
- intentionally unchanged scenes are still treated as frozen
- transmitter fallback heuristic detection can mark scenes as flagged
- failed analysis marks only that scene `unknown`
- stale guard state is treated as `unknown`
- direct cuts are intercepted only when cached guard state is `flagged`
- remote preview staging never triggers confirmation
- `Transition` is intercepted only when the staged scene is `flagged`
- confirming a flagged switch sends the OBS command
- canceling a flagged switch does not send the OBS command

### UI Coverage

Minimum UI coverage:

- flagged scenes render a warning state
- warning dialog lists exact reason labels
- `Unknown` scenes do not trigger the warning dialog
- `Switch anyway` proceeds
- `Cancel` blocks the switch

## Risks And Tradeoffs

- Continuously sampling every scene increases OBS screenshot request volume.
- Frozen detection on every scene will also flag intentionally static scenes, causing confirmation prompts by design.
- Heuristic transmitter fallback detection may have false positives until a real reference screenshot is available.
- Large scene counts may reduce freshness per scene because the watchdog is intentionally serial.

These tradeoffs are acceptable because the design prioritizes instant switching, broad scene coverage, and conservative blocking behavior.

## Implementation Notes

- Keep the guard engine centered in `src/lib/obs-client.ts`.
- Keep the confirmation UI centered in `src/components/ObsPanel.tsx`.
- Reuse existing dialog primitives instead of introducing a new modal system.
- Keep the large live program monitor separate from the small analysis-screenshot path.
- Avoid changing unrelated OBS stream, record, and program-monitor behavior.
