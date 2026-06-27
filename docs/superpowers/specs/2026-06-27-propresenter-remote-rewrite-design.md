# ProPresenter Remote Rewrite Design

**Date:** 2026-06-27

## Objective

Rewrite the ProPresenter side of Stage Deck as a reliable remote-control client backed by the official [ProPresenter OpenAPI](https://openapi.propresenter.com/). The remote reads status from ProPresenter and sends control commands to it. The existing OBS implementation and UI are out of scope and must remain unchanged.

## Current Failure

The existing client does not consistently implement the OpenAPI contract:

- it reads the active presentation name from the wrong response location;
- it calculates the slide count from fields absent from the documented schema;
- it treats `/version.name` as the application version instead of the machine name;
- its transport does not support every HTTP method and body shape represented by its client API;
- unused actions use invalid paths or methods;
- polling and action failures are swallowed, leaving the UI stale with no operator feedback;
- the current tests describe behavior the production transport cannot represent.

## Scope

### In scope

- `src/lib/propresenter-api.server.ts`
- `src/lib/api/propresenter.functions.ts`
- `src/lib/propresenter-client.ts`
- `src/components/ProPresenterPanel.tsx`
- only the ProPresenter portion of `src/components/ConnectionSettings.tsx`
- ProPresenter-focused unit, integration, and UI contract tests

### Out of scope

- OBS client behavior
- `ObsPanel` UI
- OBS connection settings
- the dashboard's overall composition and responsive grid
- generating a client for every endpoint in the OpenAPI document
- adding ProPresenter features not represented by the approved controls

## Architecture

The implementation has four boundaries:

1. **Server transport:** forwards validated HTTP requests from Stage Deck's server to the configured ProPresenter host. It supports `GET` and `PUT`, optional JSON request bodies, JSON or text responses, and empty `204` responses.
2. **Server function:** validates the base URL, method, body, and path against the supported ProPresenter operations before calling the server transport.
3. **ProPresenter client:** exposes connection, status refresh, presentation navigation, layer clearing, and timer operations. It converts OpenAPI responses into a stable, UI-oriented `PpState`.
4. **React UI:** subscribes to `PpClient`, renders status, and invokes commands with visible pending and failure states.

The client will define explicit endpoint constants or operation functions for the supported feature set. Components will not construct paths or interpret raw OpenAPI responses.

## Supported OpenAPI Operations

| Remote behavior | Method and endpoint |
| --- | --- |
| Connect and identify host | `GET /version` |
| Read active presentation | `GET /v1/presentation/active` |
| Read current cue index | `GET /v1/presentation/slide_index` |
| Previous cue | `GET /v1/presentation/active/previous/trigger` |
| Next cue | `GET /v1/presentation/active/next/trigger` |
| Clear a supported layer | `GET /v1/clear/layer/{layer}` |
| Start, stop, or reset a timer | `GET /v1/timer/{id}/{operation}` |

Supported clear layers are exactly `audio`, `props`, `messages`, `announcements`, `slide`, `media`, and `video_input`. "Clear All" calls those seven documented operations in sequence and reports the first failure instead of claiming success.

Timer identifiers may be a UUID, name, or index and must be path-encoded. Timer operations are limited to `start`, `stop`, and `reset`.

Unused and incorrect client actions such as the current logo and audience-screen implementations will not remain in the public UI client surface.

## OpenAPI Response Mapping

`GET /version` maps:

- `name` to the ProPresenter machine name;
- `host_description` to the displayed ProPresenter version/host description;
- `api_version` to diagnostic state when available.

`GET /v1/presentation/active` maps:

- `presentation.id.name` to the active presentation name;
- the sum of every `presentation.groups[*].slides.length` to the total cue count.

`GET /v1/presentation/slide_index` maps `presentation_index.index` to the zero-based current cue index. The UI displays this as a one-based number.

All parsers accept `unknown`, validate the required shape, and return explicit empty state when ProPresenter reports no active presentation. Invalid non-empty payloads are treated as refresh failures rather than silently interpreted.

## Connection and Polling

Connecting performs `GET /version`, stores the normalized base URL, fetches initial presentation status, then starts one 1.5-second polling loop. Reconnecting always clears the previous loop first. Disconnecting clears the loop, pending action state, status data, and errors.

Each refresh requests the active presentation and slide index concurrently. The refresh succeeds only when both requests and both parsers succeed, preventing a mixed snapshot. A successful refresh replaces the presentation snapshot and clears degraded state. Any failed refresh preserves the last successful snapshot, marks the connection degraded, and exposes a concise warning. Three consecutive failed refreshes mark the connection offline while polling continues, allowing automatic recovery when ProPresenter responds again.

Overlapping refreshes are prevented so a slow response cannot be overtaken by a newer poll and then overwrite newer state.

## Action Behavior

Only one command of a given control group may be pending at a time. Duplicate taps are ignored while that command is pending. The client exposes the active command and the most recent action error.

Successful navigation and timer commands trigger an immediate status refresh. Successful clear commands clear their pending state without fabricating presentation data. Failed commands preserve connection status, show the error in the ProPresenter panel, and remain retryable.

HTTP errors include the status code and a safe response message when available. Network failures are normalized into operator-readable messages. Errors are not swallowed or restricted to `console.error`.

## ProPresenter UI/UX

The ProPresenter panel remains in its current dashboard position.

- The header shows Online, Degraded, or Offline plus machine name and host description.
- A prominent status card shows the active presentation and `Slide X of Y`.
- Previous and Next remain the largest primary controls.
- Clear-layer controls are visually separated from navigation.
- Clear All uses destructive styling and requires confirmation before issuing requests.
- Timer controls accept UUID, name, or index and expose Start, Stop, and Reset with pending feedback.
- Pending controls are disabled to prevent duplicate commands.
- Refresh warnings and command failures render inline without replacing the last valid presentation snapshot.

The ProPresenter connection section validates an `http://` or `https://` base URL, shows connection progress, and reports connection errors beside the input. The OBS connection section is unchanged.

## Testing Strategy

Development follows test-driven development.

### Unit tests

- parse official `/version`, active presentation, and slide-index examples;
- count slides across presentation groups;
- represent no active presentation without throwing;
- reject malformed non-empty payloads;
- verify polling, overlap prevention, degraded/offline thresholds, recovery, and disconnect cleanup;
- verify pending action state, duplicate prevention, immediate refresh, and action errors;
- verify all navigation, clear-layer, Clear All, and timer paths.

### Integration tests

- exercise the server transport against a local fake ProPresenter HTTP server;
- verify GET requests, PUT bodies, JSON responses, text responses, empty `204` responses, and useful HTTP errors;
- verify server-function input validation.

### UI contract tests

- cover Online, Degraded, Offline, pending, inline-error, and Clear All confirmation states;
- confirm that only the ProPresenter section of Connection Settings changes;
- guard against modifications to OBS files and dashboard composition.

### Final verification

- focused ProPresenter tests;
- complete test suite;
- lint;
- production build;
- browser verification of the ProPresenter panel at desktop and narrow tablet widths.

## Success Criteria

- Connecting to a reachable ProPresenter instance displays its documented host information.
- The active presentation name and slide position are derived from official response fields.
- Previous, Next, all documented clear layers, Clear All, and timer operations use the exact OpenAPI endpoints.
- Operators receive visible pending, degraded, and failure feedback.
- Polling cannot leak, overlap, or overwrite newer state.
- All tests, lint, and build pass.
- No OBS implementation or UI behavior changes.
