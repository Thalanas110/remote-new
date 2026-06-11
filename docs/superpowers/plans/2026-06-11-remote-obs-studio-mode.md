# Remote OBS Studio Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OBS "studio mode" on the remote a purely local preview workflow that never changes OBS Studio's real studio mode on the host laptop.

**Architecture:** Keep the change centered in `ObsClient` and `ObsPanel`. Move studio-mode control flow to remote-local state (`remoteStudioMode`, `remotePreviewScene`) and stop calling OBS native studio-mode APIs. Cover the behavior with a focused Node built-in test file that exercises `ObsClient` directly with a fake OBS transport.

**Tech Stack:** React 19, TanStack Start, TypeScript, obs-websocket-js, Node built-in test runner

---

## File Structure

- Modify: `src/lib/obs-client.ts`
  Purpose: own remote-local studio mode state and map scene actions to either local preview or OBS program changes.
- Modify: `src/components/ObsPanel.tsx`
  Purpose: rename studio controls to remote-local language and render `LIVE`/`PREV` from remote-local state.
- Modify: `package.json`
  Purpose: add a targeted npm test script for the OBS remote studio regression test.
- Create: `src/lib/obs-client.remote-studio.test.ts`
  Purpose: regression coverage for host-isolated remote studio behavior using `node:test`.

### Task 1: Add Failing OBS Remote Studio Tests

**Files:**
- Create: `src/lib/obs-client.remote-studio.test.ts`
- Modify: `package.json`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { ObsClient } from "./obs-client";

type FakeObs = {
  calls: Array<{ method: string; args?: Record<string, unknown> }>;
  call: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  on: () => void;
  off: () => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

function createClient() {
  const client = new ObsClient();
  const fakeObs: FakeObs = {
    calls: [],
    async call(method, args) {
      this.calls.push({ method, args });
      return {};
    },
    on() {},
    off() {},
    async connect() {},
    async disconnect() {},
  };

  client.obs = fakeObs as never;
  client.state = {
    connected: true,
    currentScene: "Scene A",
    scenes: ["Scene A", "Scene B"],
    streaming: false,
    recording: false,
    recordPaused: false,
    virtualCam: false,
    remoteStudioMode: false,
    remotePreviewScene: "Scene A",
  };

  return { client, fakeObs };
}

test("remote studio toggle does not call OBS studio mode APIs", async () => {
  const { client, fakeObs } = createClient();

  client.toggleRemoteStudio();
  client.toggleRemoteStudio();

  assert.equal(client.state.remoteStudioMode, false);
  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetStudioModeEnabled"),
    [],
  );
});

test("setScene hard-cuts when remote studio is off", async () => {
  const { client, fakeObs } = createClient();

  await client.setScene("Scene B");

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
  assert.equal(client.state.remotePreviewScene, "Scene A");
});

test("setScene updates only local preview when remote studio is on", async () => {
  const { client, fakeObs } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");

  assert.equal(client.state.remotePreviewScene, "Scene B");
  assert.deepEqual(
    fakeObs.calls.filter((call) => call.method === "SetCurrentProgramScene"),
    [],
  );
});

test("triggerTransition promotes local preview to OBS program", async () => {
  const { client, fakeObs } = createClient();

  client.toggleRemoteStudio();
  await client.setScene("Scene B");
  await client.triggerTransition();

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "SetCurrentProgramScene",
    args: { sceneName: "Scene B" },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/lib/obs-client.remote-studio.test.ts`

Expected: FAIL with missing `remoteStudioMode`/`remotePreviewScene` fields or missing `toggleRemoteStudio()` behavior.

- [ ] **Step 3: Add npm script for repeatable execution**

```json
"test:obs-remote-studio": "node --test --experimental-strip-types src/lib/obs-client.remote-studio.test.ts"
```

- [ ] **Step 4: Re-run the failing test through npm**

Run: `npm run test:obs-remote-studio`

Expected: FAIL for the same missing behavior, but with the permanent script in place.

### Task 2: Implement Remote-Local OBS Studio State

**Files:**
- Modify: `src/lib/obs-client.ts`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Add remote-local state fields to `ObsState` and defaults**

```ts
export type ObsState = {
  connected: boolean;
  currentScene: string | null;
  scenes: string[];
  remoteStudioMode: boolean;
  remotePreviewScene: string | null;
  streaming: boolean;
  recording: boolean;
  recordPaused: boolean;
  virtualCam: boolean;
  error?: string;
};

export const defaultObsState: ObsState = {
  connected: false,
  currentScene: null,
  scenes: [],
  remoteStudioMode: false,
  remotePreviewScene: null,
  streaming: false,
  recording: false,
  recordPaused: false,
  virtualCam: false,
};
```

- [ ] **Step 2: Remove OBS-native studio-mode control flow and add local toggle**

```ts
toggleRemoteStudio() {
  const next = !this.state.remoteStudioMode;
  this.update({
    remoteStudioMode: next,
    remotePreviewScene: next
      ? this.state.remotePreviewScene ?? this.state.currentScene
      : this.state.currentScene,
  });
}
```

- [ ] **Step 3: Seed and preserve local preview correctly during refresh and passive OBS updates**

```ts
this.obs.on("CurrentProgramSceneChanged", (d: any) =>
  this.update({
    currentScene: d.sceneName,
    remotePreviewScene: this.state.remoteStudioMode
      ? this.state.remotePreviewScene
      : d.sceneName,
  })
);

this.update({
  scenes: sceneList.scenes.map((s: any) => s.sceneName).reverse(),
  currentScene: sceneList.currentProgramSceneName,
  remotePreviewScene:
    this.state.remotePreviewScene ?? sceneList.currentProgramSceneName,
  streaming: stream.outputActive,
  recording: record.outputActive,
  recordPaused: record.outputPaused,
  virtualCam: vcam,
});
```

- [ ] **Step 4: Route scene selection and transition through remote-local behavior**

```ts
async setScene(name: string) {
  if (this.state.remoteStudioMode) {
    this.update({ remotePreviewScene: name });
    return;
  }

  await this.obs.call("SetCurrentProgramScene", { sceneName: name });
}

async triggerTransition() {
  const sceneName = this.state.remotePreviewScene;
  if (!sceneName || sceneName === this.state.currentScene) {
    return;
  }

  await this.obs.call("SetCurrentProgramScene", { sceneName });
  this.update({ currentScene: sceneName });
}
```

- [ ] **Step 5: Delete OBS native studio-mode API calls that should never be used**

Remove:

```ts
this.obs.on("CurrentPreviewSceneChanged", ...)
this.obs.on("StudioModeStateChanged", ...)
const studio: any = await this.obs.call("GetStudioModeEnabled");
return this.obs.call("TriggerStudioModeTransition");
return this.obs.call("SetStudioModeEnabled", ...);
return this.obs.call("SetCurrentPreviewScene", ...);
```

- [ ] **Step 6: Run the focused regression test**

Run: `npm run test:obs-remote-studio`

Expected: PASS

### Task 3: Update the OBS Panel to Match Remote-Local Studio Mode

**Files:**
- Modify: `src/components/ObsPanel.tsx`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Read remote-local fields from state**

```tsx
const remoteStudioOn = s.remoteStudioMode;
const previewScene = s.remotePreviewScene;
```

- [ ] **Step 2: Rename the studio UI to remote-local language**

```tsx
<StatusCard
  label="Remote Studio"
  active={remoteStudioOn}
  accent="var(--obs)"
  icon={<Eye className="h-4 w-4" />}
/>

<Btn
  onClick={call(() => obsClient.toggleRemoteStudio())}
  active={remoteStudioOn}
  accent="var(--obs)"
  disabled={offline}
>
  Remote Studio
</Btn>
```

- [ ] **Step 3: Show `Transition` only for remote-local studio mode**

```tsx
{remoteStudioOn && (
  <button
    onClick={call(() => obsClient.triggerTransition())}
    disabled={offline || !previewScene || previewScene === s.currentScene}
  >
    Transition
  </button>
)}
```

- [ ] **Step 4: Mark `PREV` from local preview instead of OBS preview**

```tsx
const isProgram = s.currentScene === name;
const isPreview = remoteStudioOn && previewScene === name;
```

- [ ] **Step 5: Run the focused regression test and typecheck**

Run: `npm run test:obs-remote-studio`
Expected: PASS

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

### Task 4: Final Verification

**Files:**
- Modify: none
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Verify the exact regression behavior**

Run:

```bash
npm run test:obs-remote-studio
npx tsc -p tsconfig.json --noEmit
```

Expected:

- remote studio tests pass
- typecheck passes

- [ ] **Step 2: Verify the dev server still starts**

Run: `npm run dev`

Expected: Vite starts on `http://localhost:5173/` without the previous config-loader failure.
