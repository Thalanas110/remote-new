# OBS Program Monitor Design

Date: 2026-06-12

## Summary

The OBS panel should show an in-app program monitor above the existing controls. The monitor will use OBS WebSocket screenshot requests to repeatedly capture the current live program scene and render it as a fast-refresh image inside the app.

## Problem

The current OBS panel only exposes state and controls. It does not show what is actually live in OBS, which makes the remote feel incomplete compared with production switcher remotes that include a built-in program monitor.

OBS WebSocket in this app's current stack does not expose a continuous video stream. It does expose `GetSourceScreenshot`, which returns base64 image data for a source. The design should use that existing capability instead of introducing a second transport.

## Goals

- Show the current OBS program output inside the OBS panel.
- Reuse the existing OBS WebSocket connection with no extra OBS plugins or stream endpoints.
- Refresh the monitor automatically while OBS is connected.
- Refresh immediately when the live scene changes.
- Keep the existing scene, stream, record, and remote studio controls intact.
- Degrade gracefully when screenshot capture fails.

## Non-Goals

- True continuous video playback.
- Audio monitoring.
- Additional setup steps such as Virtual Camera, RTSP, HLS, WebRTC, or browser capture permissions.
- Replacing the OBS control model already implemented in `ObsClient`.

## Approved Approach

### Transport

Use `GetSourceScreenshot` against the current program scene name from OBS WebSocket. The result is a base64 image string that can be rendered directly in the browser as a data URL.

### Refresh Model

The monitor should behave like a remote program preview:

- fetch immediately after OBS connects and the initial scene list loads
- fetch immediately when `CurrentProgramSceneChanged` fires
- continue polling on a short interval while OBS remains connected
- stop polling when OBS disconnects

This gives a responsive monitor without adding a second media pipeline.

## State Model

`ObsState` should gain a nested program monitor state:

```ts
programMonitor: {
  imageDataUrl: string | null;
  loading: boolean;
  error?: string;
  lastUpdatedAt: number | null;
}
```

Default behavior:

- `imageDataUrl` starts as `null`
- `loading` starts as `false`
- `error` starts as `undefined`
- `lastUpdatedAt` starts as `null`

Reset rules:

- on disconnect, reset the monitor state to defaults
- on screenshot failure, preserve the last successful image and update `error`
- on successful screenshot refresh, clear `error` and update `lastUpdatedAt`

## Client Behavior

### `ObsClient` Responsibilities

`ObsClient` should own monitor polling so the UI remains passive.

Required behavior:

- keep a single polling timer at a time
- start polling after a successful connect and refresh cycle
- stop polling on disconnect
- avoid overlapping screenshot requests
- no-op when there is no current program scene

### Screenshot Request

For each refresh, call:

```ts
await this.obs.call("GetSourceScreenshot", {
  sourceName: this.state.currentScene,
  imageFormat: "jpeg",
  imageWidth: 960,
  imageCompressionQuality: 75,
});
```

Notes:

- use the current program scene name as the screenshot target
- use JPEG to keep payload size lower than PNG
- use a moderate width so the panel remains responsive on tablets and desktops

### Failure Handling

If OBS rejects a screenshot request for the current scene:

- keep showing the last successful frame if one exists
- set a small error state for the UI
- continue polling so recovery happens automatically after the next successful request

This avoids blanking the monitor due to a temporary failure.

## UI Changes

### OBS Panel Layout

Add a monitor card near the top of `ObsPanel`, below the header and offline notice, before the status row.

The card should include:

- a label such as `Live Program`
- a compact refresh status such as `Updating...` or `Updated just now`
- the latest screenshot image in a fixed aspect-ratio frame

### Empty, Loading, and Error States

- while the first image is loading, show a skeleton or muted placeholder
- if OBS is offline, show a disconnected message in the frame
- if screenshot capture fails before any image exists, show a monitor unavailable message
- if screenshot capture fails after a successful image, keep the image visible and show a subtle warning line

### Interaction

The monitor is display-only. It does not replace scene buttons or transitions and does not accept direct clicks for switching.

## Testing Strategy

Implementation should follow TDD.

Minimum coverage in `ObsClient` tests:

- after connect and refresh, the client requests a screenshot for the current program scene
- program scene changes trigger an immediate screenshot refresh
- a polling loop starts only once and stops on disconnect
- successful screenshot refresh updates `programMonitor.imageDataUrl`, clears errors, and sets `lastUpdatedAt`
- failed screenshot refresh preserves the last good image and records an error
- if there is no current scene, screenshot refresh is skipped

UI verification should confirm:

- the monitor renders the latest image when available
- offline, loading, and error states are visible in the right situations
- existing OBS controls still render and behave as before

## Risks and Tradeoffs

- This is not true video. Fast scene motion will appear as refreshed stills.
- Some OBS scene types may fail screenshot capture depending on source composition or OBS behavior.
- Frequent screenshot polling increases OBS request volume, so the interval should stay moderate.

These tradeoffs are acceptable because the design prioritizes speed of delivery and zero extra OBS setup.

## Implementation Notes

- Keep the change centered in `src/lib/obs-client.ts`, `src/components/ObsPanel.tsx`, and focused tests.
- Avoid changing unrelated OBS stream, record, or remote studio behavior.
- Keep monitor logic encapsulated in the client so the component only renders state.
