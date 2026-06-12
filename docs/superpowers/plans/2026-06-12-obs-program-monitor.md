# OBS Program Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app OBS program monitor that shows the current live scene as a fast-refresh image above the existing OBS controls.

**Architecture:** Extend `ObsClient` with screenshot-backed program monitor state plus a single polling loop driven by the existing OBS WebSocket connection. Keep `ObsPanel` passive by rendering the monitor directly from client state and preserving the current controls below it.

**Tech Stack:** React 19, TanStack Start, TypeScript, obs-websocket-js, Node built-in test runner

---

## File Structure

- Modify: `src/lib/obs-client.remote-studio.test.ts`
  Purpose: extend the focused OBS client regression tests to cover screenshot refresh, polling lifecycle, and failure handling.
- Modify: `src/lib/obs-client.ts`
  Purpose: add program monitor state, screenshot normalization, polling helpers, and event wiring.
- Modify: `src/components/ObsPanel.tsx`
  Purpose: render the live program monitor card and its loading/error/offline states above the existing status controls.

### Task 1: Add Failing OBS Program Monitor Tests

**Files:**
- Modify: `src/lib/obs-client.remote-studio.test.ts`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Extend the fake OBS transport so tests can trigger events and throw screenshot errors**

```ts
type FakeObs = {
  calls: CallRecord[];
  responses: Map<string, unknown>;
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
    ["GetSourceScreenshot", { imageData: "ZmFrZS1mcmFtZQ==" }],
  ]),
  handlers: new Map(),
  async call(method, args) {
    this.calls.push({ method, args });
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

- [ ] **Step 2: Add failing tests for initial refresh, scene-change refresh, failure preservation, and disconnect cleanup**

```ts
test("connect fetches the initial program monitor frame", async () => {
  const { client, fakeObs } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });

  assert.equal(
    fakeObs.calls.some((call) => call.method === "GetSourceScreenshot"),
    true,
  );
  assert.match(
    client.state.programMonitor.imageDataUrl ?? "",
    /^data:image\/jpeg;base64,/,
  );
  assert.equal(client.state.programMonitor.error, undefined);
  assert.equal(typeof client.state.programMonitor.lastUpdatedAt, "number");
});

test("program scene changes trigger an immediate monitor refresh", async () => {
  const { client, fakeObs } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });
  fakeObs.responses.set("GetSourceScreenshot", { imageData: "bmV4dC1mcmFtZQ==" });
  fakeObs.trigger("CurrentProgramSceneChanged", { sceneName: "Scene B" });
  await Promise.resolve();

  assert.deepEqual(fakeObs.calls.at(-1), {
    method: "GetSourceScreenshot",
    args: {
      sourceName: "Scene B",
      imageFormat: "jpeg",
      imageWidth: 960,
      imageCompressionQuality: 75,
    },
  });
  assert.equal(client.state.currentScene, "Scene B");
});

test("failed monitor refresh preserves the last good frame", async () => {
  const { client, fakeObs } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });
  const firstFrame = client.state.programMonitor.imageDataUrl;

  fakeObs.responses.set("GetSourceScreenshot", new Error("screenshot failed"));
  fakeObs.trigger("CurrentProgramSceneChanged", { sceneName: "Scene B" });
  await Promise.resolve();

  assert.equal(client.state.programMonitor.imageDataUrl, firstFrame);
  assert.equal(client.state.programMonitor.error, "screenshot failed");
  assert.equal(client.state.programMonitor.loading, false);
});

test("disconnect clears the monitor state", async () => {
  const { client } = createClient();

  await client.connect({ url: "ws://127.0.0.1:4455" });
  await client.disconnect();

  assert.equal(client.state.programMonitor.imageDataUrl, null);
  assert.equal(client.state.programMonitor.lastUpdatedAt, null);
  assert.equal(client.state.programMonitor.loading, false);
});
```

- [ ] **Step 3: Run the focused OBS test script to verify the new tests fail for the expected reason**

Run: `npm run test:obs-remote-studio`

Expected: FAIL with TypeScript/runtime errors because `programMonitor` state and screenshot refresh behavior do not exist yet.

- [ ] **Step 4: Commit the red test changes**

```bash
git add src/lib/obs-client.remote-studio.test.ts
git commit -m "test: cover OBS program monitor behavior"
```

### Task 2: Implement Program Monitor State and Polling in `ObsClient`

**Files:**
- Modify: `src/lib/obs-client.ts`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Add a dedicated program monitor state type and defaults**

```ts
export type ObsProgramMonitorState = {
  imageDataUrl: string | null;
  loading: boolean;
  error?: string;
  lastUpdatedAt: number | null;
};

const defaultProgramMonitorState: ObsProgramMonitorState = {
  imageDataUrl: null,
  loading: false,
  error: undefined,
  lastUpdatedAt: null,
};

export type ObsState = {
  connected: boolean;
  currentScene: string | null;
  scenes: string[];
  remoteStudioMode: boolean;
  remotePreviewScene: string | null;
  programMonitor: ObsProgramMonitorState;
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
  programMonitor: { ...defaultProgramMonitorState },
  streaming: false,
  recording: false,
  recordPaused: false,
  virtualCam: false,
};
```

- [ ] **Step 2: Add screenshot normalization plus refresh helpers with overlap protection**

```ts
const PROGRAM_MONITOR_WIDTH = 960;
const PROGRAM_MONITOR_INTERVAL_MS = 1500;

function toScreenshotDataUrl(imageData: string, format: string) {
  if (imageData.startsWith("data:")) {
    return imageData;
  }

  return `data:image/${format};base64,${imageData}`;
}

export class ObsClient {
  obs = new OBSWebSocket();
  private listeners = new Set<(s: ObsState) => void>();
  private programMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorRefreshInFlight: Promise<void> | null = null;
  state: ObsState = { ...defaultObsState };

  private updateProgramMonitor(patch: Partial<ObsProgramMonitorState>) {
    this.update({
      programMonitor: {
        ...this.state.programMonitor,
        ...patch,
      },
    });
  }

  private async refreshProgramMonitor() {
    const sceneName = this.state.currentScene;
    if (!sceneName) {
      return;
    }

    if (this.monitorRefreshInFlight) {
      return this.monitorRefreshInFlight;
    }

    this.updateProgramMonitor({
      loading: true,
      error: undefined,
    });

    this.monitorRefreshInFlight = (async () => {
      try {
        const result: any = await this.obs.call("GetSourceScreenshot", {
          sourceName: sceneName,
          imageFormat: "jpeg",
          imageWidth: PROGRAM_MONITOR_WIDTH,
          imageCompressionQuality: 75,
        });

        this.updateProgramMonitor({
          imageDataUrl: toScreenshotDataUrl(result.imageData, "jpeg"),
          loading: false,
          error: undefined,
          lastUpdatedAt: Date.now(),
        });
      } catch (e: any) {
        this.updateProgramMonitor({
          loading: false,
          error: e?.message ?? "Monitor refresh failed",
        });
      } finally {
        this.monitorRefreshInFlight = null;
      }
    })();

    return this.monitorRefreshInFlight;
  }
}
```

- [ ] **Step 3: Start polling after connect, refresh on program scene changes, and stop/reset on disconnect**

```ts
private startProgramMonitorPolling() {
  if (this.programMonitorTimer) {
    return;
  }

  this.programMonitorTimer = setInterval(() => {
    void this.refreshProgramMonitor();
  }, PROGRAM_MONITOR_INTERVAL_MS);
}

private stopProgramMonitorPolling() {
  if (!this.programMonitorTimer) {
    return;
  }

  clearInterval(this.programMonitorTimer);
  this.programMonitorTimer = null;
}

async connect(config: ObsConfig) {
  try {
    await this.obs.disconnect().catch(() => {});
    await this.obs.connect(config.url, config.password || undefined);
    this.bindEvents();
    await this.refreshAll();
    this.update({ connected: true, error: undefined });
    await this.refreshProgramMonitor();
    this.startProgramMonitorPolling();
  } catch (e: any) {
    this.stopProgramMonitorPolling();
    this.update({
      connected: false,
      error: e?.message ?? "Failed to connect",
      programMonitor: { ...defaultProgramMonitorState },
    });
    throw e;
  }
}

async disconnect() {
  this.stopProgramMonitorPolling();
  await this.obs.disconnect().catch(() => {});
  this.update({ ...defaultObsState });
}

private bindEvents() {
  this.obs.off("ConnectionClosed" as any);
  this.obs.on("ConnectionClosed", () => {
    this.stopProgramMonitorPolling();
    this.update({
      connected: false,
      programMonitor: { ...defaultProgramMonitorState },
    });
  });
  this.obs.on("CurrentProgramSceneChanged", (d: any) => {
    this.update({
      currentScene: d.sceneName,
      remotePreviewScene: this.state.remoteStudioMode
        ? this.state.remotePreviewScene
        : d.sceneName,
    });
    void this.refreshProgramMonitor();
  });
}
```

- [ ] **Step 4: Keep `refreshAll()` responsible for state only, with monitor refresh handled by `connect()` and scene-change events**

```ts
this.update({
  scenes: sceneList.scenes.map((s: any) => s.sceneName).reverse(),
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
```

- [ ] **Step 5: Run the focused OBS test script until the new monitor tests pass**

Run: `npm run test:obs-remote-studio`

Expected: PASS with the remote-studio tests and new program monitor tests all green.

- [ ] **Step 6: Commit the client implementation**

```bash
git add src/lib/obs-client.ts src/lib/obs-client.remote-studio.test.ts
git commit -m "feat: add OBS program monitor polling"
```

### Task 3: Render the Program Monitor in `ObsPanel`

**Files:**
- Modify: `src/components/ObsPanel.tsx`
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Read program monitor state from `ObsState` and derive the panel status text**

```tsx
const monitor = s.programMonitor;
const monitorUpdatedAt = monitor.lastUpdatedAt
  ? new Date(monitor.lastUpdatedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  : null;

const monitorStatus = !s.connected
  ? "Disconnected"
  : monitor.loading && !monitor.imageDataUrl
    ? "Loading..."
    : monitor.error && !monitor.imageDataUrl
      ? "Unavailable"
      : monitorUpdatedAt
        ? `Updated ${monitorUpdatedAt}`
        : "Waiting for frame";
```

- [ ] **Step 2: Insert the live monitor card above the status row**

```tsx
<div className="mt-4 rounded-xl border border-border bg-card/60 p-3">
  <div className="mb-2 flex items-center justify-between gap-3">
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Live Program
      </h3>
      <p className="text-xs text-muted-foreground">{monitorStatus}</p>
    </div>
    {monitor.error && monitor.imageDataUrl && (
      <span className="pill text-amber-200" style={{ background: "rgba(245, 158, 11, 0.12)" }}>
        Stale Frame
      </span>
    )}
  </div>

  <div className="overflow-hidden rounded-xl border border-border bg-black/70">
    <div className="aspect-video">
      {monitor.imageDataUrl ? (
        <img
          src={monitor.imageDataUrl}
          alt="OBS live program monitor"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
          {!s.connected
            ? "Connect OBS to load the live program monitor."
            : monitor.error
              ? "Program monitor unavailable for this scene."
              : "Loading live program monitor..."}
        </div>
      )}
    </div>
  </div>

  {monitor.error && (
    <p className="mt-2 text-[11px] text-muted-foreground">
      {monitor.imageDataUrl
        ? "Monitor refresh failed. Showing the last good frame."
        : monitor.error}
    </p>
  )}
</div>
```

- [ ] **Step 3: Keep the existing OBS controls and scene grid below the new monitor without behavior changes**

No code change belongs in this step. Use it as a layout check:

- the new monitor block from Step 2 must sit directly before the existing status row
- the status row, control buttons, and scene grid should keep their current logic and ordering

- [ ] **Step 4: Verify the targeted tests still pass and the app typechecks**

Run: `npm run test:obs-remote-studio`
Expected: PASS

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 5: Commit the panel rendering**

```bash
git add src/components/ObsPanel.tsx
git commit -m "feat: render OBS program monitor"
```

### Task 4: Final Verification

**Files:**
- Modify: none
- Test: `src/lib/obs-client.remote-studio.test.ts`

- [ ] **Step 1: Run the final focused verification suite**

Run: `npm run test:obs-remote-studio`

Expected: PASS

Run: `npx tsc -p tsconfig.json --noEmit`

Expected: PASS

- [ ] **Step 2: Build the app to catch integration regressions**

Run: `npm run build`

Expected: Vite build completes successfully with no TypeScript or bundling errors.
