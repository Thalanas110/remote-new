# Remote OBS Studio Mode Design

Date: 2026-06-11

## Summary

The OBS panel should support a remote-only "studio mode" workflow that does not change OBS Studio's real studio mode on the host laptop. When remote studio mode is enabled in the tablet UI, scene taps should update a local preview inside the remote only. OBS program output should change only when the user presses `Transition`.

## Problem

The current implementation maps the remote's `Studio Mode` button to OBS's real `SetStudioModeEnabled` API and uses OBS's native preview/program state as the remote control model. That means the tablet changes the host laptop's studio mode, which is explicitly unwanted.

## Goals

- Remote studio enable/disable must not affect OBS Studio on the host laptop.
- Remote scene preview must remain local to the tablet UI.
- `Transition` must apply the local preview scene to OBS program output.
- Normal direct-cut behavior must still work when remote studio mode is off.
- The UI must make it clear this is a remote-local workflow, not OBS native studio mode.

## Non-Goals

- Mirroring OBS's real studio mode state.
- Keeping OBS preview scene in sync with the remote preview.
- Supporting both host-native studio mode and remote-local studio mode at the same time.
- Multi-remote collaboration or conflict resolution.

## Agreed Behavior

### Remote Studio Off

- Tapping a scene sends `SetCurrentProgramScene`.
- The selected scene becomes live immediately in OBS.
- No local preview state is used.

### Remote Studio On

- Tapping a scene updates only the remote-local preview scene.
- OBS program output does not change until `Transition` is pressed.
- `Transition` sends `SetCurrentProgramScene(remotePreviewScene)`.
- Enabling or disabling remote studio mode never sends `SetStudioModeEnabled`.

### Host OBS Studio Behavior

- The remote ignores OBS's real studio mode state completely.
- If the host laptop is already using OBS native studio mode, the remote still uses its own local studio mode rules.
- The host laptop's native preview/program UI may differ from the remote's local preview. This is acceptable and intentional.

## State Model

`ObsState` should gain remote-local fields:

- `remoteStudioMode: boolean`
- `remotePreviewScene: string | null`

The remote UI should stop using OBS-native `studioMode` and `previewScene` for control flow.

State rules:

- On initial connect, seed `remotePreviewScene` from `currentScene`.
- When remote studio mode turns on, if `remotePreviewScene` is null, set it to `currentScene`.
- When remote studio mode turns off, set `remotePreviewScene` to `currentScene`.
- Passive OBS program-scene updates must not overwrite `remotePreviewScene` while remote studio mode is on.
- On disconnect, reset remote-local state to defaults.

## OBS API Boundaries

The remote continues reading passive OBS state:

- scene list
- current program scene
- stream status
- record status
- virtual camera status

The remote should stop using these OBS APIs:

- `GetStudioModeEnabled`
- `SetStudioModeEnabled`
- `SetCurrentPreviewScene`
- `TriggerStudioModeTransition`

Remote actions should map as follows:

- `toggleRemoteStudio()`: local state update only
- `setScene(name)`:
  - if remote studio mode is off: call `SetCurrentProgramScene`
  - if remote studio mode is on: update `remotePreviewScene` only
- `triggerTransition()`:
  - if `remotePreviewScene` is set and different from `currentScene`, call `SetCurrentProgramScene(remotePreviewScene)`
  - after success, update local state so `currentScene` reflects the promoted scene

## UI Changes

### Labels

- Rename the OBS control button from `Studio Mode` to `Remote Studio`.
- Rename the status card from `Studio` to `Remote Studio` or `Remote Prev`.
  Recommendation: `Remote Studio` for the toggle/status card, because it matches the user mental model.

### Scene Grid

- `LIVE` badge continues to reflect OBS `currentScene`.
- `PREV` badge reflects `remotePreviewScene` only when remote studio mode is on.
- Double-click behavior can remain as a hard cut to program via `SetCurrentProgramScene`.

### Transition Button

- Show only when remote studio mode is on.
- Disable when:
  - OBS is offline
  - no `remotePreviewScene` exists
  - `remotePreviewScene === currentScene`

## Testing Strategy

Implementation should be driven by failing tests first.

Minimum coverage:

- enabling remote studio mode does not call `SetStudioModeEnabled`
- disabling remote studio mode does not call `SetStudioModeEnabled`
- `setScene()` hard-cuts to program when remote studio mode is off
- `setScene()` changes only local preview when remote studio mode is on
- `triggerTransition()` sends `SetCurrentProgramScene(remotePreviewScene)`
- `triggerTransition()` is a no-op when preview is missing or already live
- initial connect seeds `remotePreviewScene` from the current program scene
- passive OBS updates do not overwrite `remotePreviewScene` while remote studio mode is on
- disconnect resets remote-local state

## Risks and Tradeoffs

- The remote preview can intentionally diverge from the host laptop's OBS preview.
- If another operator changes the live program scene on the host, the remote preview may become stale until the user reselects or transitions.
- This is acceptable because the design prioritizes host isolation over full synchronization with OBS native studio mode.

## Implementation Notes

- Prefer minimal changes centered in `src/lib/obs-client.ts` and `src/components/ObsPanel.tsx`.
- Avoid touching unrelated OBS stream/record behavior.
- Keep the remote-local naming explicit in code to prevent future regressions back into OBS-native studio mode.
