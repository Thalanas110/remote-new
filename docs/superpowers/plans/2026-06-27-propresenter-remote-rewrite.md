# ProPresenter Remote Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Stage Deck's ProPresenter remote so its status reads and control commands match the official OpenAPI contract, with reliable polling and operator-focused feedback, while leaving OBS unchanged.

**Architecture:** Put endpoint construction and OpenAPI response parsing in a pure contract module, keep HTTP forwarding and Zod request validation server-side, and make `PpClient` the only stateful boundary consumed by React. The ProPresenter panel and its connection subsection subscribe to that stable client state; OBS files and dashboard composition remain unchanged.

**Tech Stack:** TypeScript, React 19, TanStack Start server functions, Zod 3, Node test runner, Radix AlertDialog, Tailwind CSS 4.

---

## File Structure

- Create `src/lib/propresenter-contract.ts`: supported endpoint builders, clear/timer enums, URL normalization, OpenAPI payload parsers, and normalized error messages.
- Create `src/lib/propresenter-request.ts`: transport request type and Zod validation for supported method/path combinations.
- Modify `src/lib/propresenter-api.server.ts`: forward GET/PUT requests, serialize bodies, parse responses, and surface useful HTTP errors.
- Modify `src/lib/api/propresenter.functions.ts`: validate with the shared request schema and call the server transport.
- Modify `src/lib/propresenter-client.ts`: connection lifecycle, non-overlapping polling, recovery, command state, and exact OpenAPI actions.
- Modify `src/components/ProPresenterPanel.tsx`: ProPresenter-only operator UI, pending/error states, and Clear All confirmation.
- Modify only the ProPresenter subsection of `src/components/ConnectionSettings.tsx`: URL validation and live connection feedback.
- Create `tests/unit/lib/propresenter-contract.test.ts`: official payload parsing and endpoint construction.
- Replace `tests/unit/lib/propresenter-client.test.ts`: lifecycle, polling, recovery, and action behavior.
- Replace `tests/integration/lib/propresenter-api.server.test.ts`: real HTTP forwarding behavior.
- Create `tests/contract/propresenter-panel-contract.test.ts`: source-level UI boundary checks consistent with the existing test stack.
- Modify `tests/contract/connection-settings-contract.test.ts`: ProPresenter validation/status checks plus OBS-preservation sentinels.

Implementation must start in an isolated worktree because the main workspace contains unrelated user changes.

### Task 1: Define the OpenAPI contract boundary

**Files:**
- Create: `src/lib/propresenter-contract.ts`
- Create: `tests/unit/lib/propresenter-contract.test.ts`

- [ ] **Step 1: Write failing parser and endpoint tests**

Create `tests/unit/lib/propresenter-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEARABLE_LAYERS,
  buildClearLayerPath,
  buildTimerPath,
  normalizeProPresenterBaseUrl,
  parseActivePresentation,
  parseSlideIndex,
  parseVersion,
} from "../../../src/lib/propresenter-contract.ts";

test("parseVersion maps documented host fields", () => {
  assert.deepEqual(
    parseVersion({
      name: "Sanctuary Mac",
      platform: "mac",
      os_version: "15.5",
      host_description: "ProPresenter 7.18.1",
      api_version: "v1",
    }),
    {
      machineName: "Sanctuary Mac",
      hostDescription: "ProPresenter 7.18.1",
      apiVersion: "v1",
    },
  );
});

test("parseActivePresentation reads presentation.id.name and grouped slides", () => {
  assert.deepEqual(
    parseActivePresentation({
      presentation: {
        id: { uuid: "presentation-1", name: "Sunday Service", index: 2 },
        groups: [
          { name: "Verse", color: "#fff", slides: [{}, {}] },
          { name: "Chorus", color: "#fff", slides: [{}, {}, {}] },
        ],
      },
    }),
    { activePresentationName: "Sunday Service", totalSlides: 5 },
  );
});

test("parseActivePresentation represents no active presentation", () => {
  assert.deepEqual(parseActivePresentation({}), {
    activePresentationName: undefined,
    totalSlides: undefined,
  });
});

test("parseActivePresentation rejects malformed non-empty data", () => {
  assert.throws(
    () => parseActivePresentation({ presentation: { name: "Wrong shape" } }),
    /active presentation/i,
  );
});

test("parseSlideIndex maps the documented presentation_index field", () => {
  assert.equal(
    parseSlideIndex({
      presentation_index: {
        index: 2,
        presentation_id: { uuid: "presentation-1", name: "Sunday Service", index: 0 },
      },
    }),
    2,
  );
});

test("endpoint builders encode only documented values", () => {
  assert.deepEqual(CLEARABLE_LAYERS, [
    "audio",
    "props",
    "messages",
    "announcements",
    "slide",
    "media",
    "video_input",
  ]);
  assert.equal(buildClearLayerPath("slide"), "/v1/clear/layer/slide");
  assert.equal(
    buildTimerPath("Service Timer", "start"),
    "/v1/timer/Service%20Timer/start",
  );
});

test("normalizeProPresenterBaseUrl accepts HTTP URLs and removes trailing slashes", () => {
  assert.equal(
    normalizeProPresenterBaseUrl(" http://192.168.1.20:50001/// "),
    "http://192.168.1.20:50001",
  );
  assert.throws(() => normalizeProPresenterBaseUrl("ws://localhost:50001"), /HTTP/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --experimental-strip-types tests/unit/lib/propresenter-contract.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/propresenter-contract.ts`.

- [ ] **Step 3: Implement the pure contract module**

Create `src/lib/propresenter-contract.ts`:

```ts
export const PP_PATHS = {
  version: "/version",
  activePresentation: "/v1/presentation/active",
  slideIndex: "/v1/presentation/slide_index",
  previous: "/v1/presentation/active/previous/trigger",
  next: "/v1/presentation/active/next/trigger",
  audienceScreens: "/v1/status/audience_screens",
} as const;

export const CLEARABLE_LAYERS = [
  "audio",
  "props",
  "messages",
  "announcements",
  "slide",
  "media",
  "video_input",
] as const;

export type ClearableLayer = (typeof CLEARABLE_LAYERS)[number];
export type TimerOperation = "start" | "stop" | "reset";

export type PpVersion = {
  machineName: string;
  hostDescription: string;
  apiVersion: string;
};

export type PpPresentationSnapshot = {
  activePresentationName?: string;
  currentSlideIndex?: number;
  totalSlides?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: missing ${key}`);
  }
  return value;
}

export function parseVersion(payload: unknown): PpVersion {
  if (!isRecord(payload)) throw new Error("Invalid ProPresenter version response");
  return {
    machineName: requiredString(payload, "name", "version response"),
    hostDescription: requiredString(payload, "host_description", "version response"),
    apiVersion: requiredString(payload, "api_version", "version response"),
  };
}

export function parseActivePresentation(
  payload: unknown,
): Pick<PpPresentationSnapshot, "activePresentationName" | "totalSlides"> {
  if (!isRecord(payload)) throw new Error("Invalid active presentation response");
  if (payload.presentation == null) {
    return { activePresentationName: undefined, totalSlides: undefined };
  }
  if (!isRecord(payload.presentation)) {
    throw new Error("Invalid active presentation response");
  }
  const presentation = payload.presentation;
  if (!isRecord(presentation.id) || !Array.isArray(presentation.groups)) {
    throw new Error("Invalid active presentation response");
  }
  const activePresentationName = requiredString(
    presentation.id,
    "name",
    "active presentation response",
  );
  let totalSlides = 0;
  for (const group of presentation.groups) {
    if (!isRecord(group) || !Array.isArray(group.slides)) {
      throw new Error("Invalid active presentation response");
    }
    totalSlides += group.slides.length;
  }
  return { activePresentationName, totalSlides };
}

export function parseSlideIndex(payload: unknown): number | undefined {
  if (!isRecord(payload)) throw new Error("Invalid slide index response");
  if (payload.presentation_index == null) return undefined;
  if (!isRecord(payload.presentation_index)) {
    throw new Error("Invalid slide index response");
  }
  const index = payload.presentation_index.index;
  if (!Number.isInteger(index) || (index as number) < 0) {
    throw new Error("Invalid slide index response");
  }
  return index as number;
}

export function buildClearLayerPath(layer: ClearableLayer) {
  return `/v1/clear/layer/${layer}` as const;
}

export function buildTimerPath(id: string, operation: TimerOperation) {
  return `/v1/timer/${encodeURIComponent(id)}/${operation}` as const;
}

export function normalizeProPresenterBaseUrl(input: string) {
  const value = input.trim();
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ProPresenter URL must use HTTP or HTTPS");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: 7 tests PASS.

- [ ] **Step 5: Commit the contract boundary**

```powershell
git add src/lib/propresenter-contract.ts tests/unit/lib/propresenter-contract.test.ts
git commit --no-gpg-sign -m "feat: define ProPresenter OpenAPI contract"
```

### Task 2: Rebuild request validation and server transport

**Files:**
- Create: `src/lib/propresenter-request.ts`
- Modify: `src/lib/propresenter-api.server.ts`
- Modify: `src/lib/api/propresenter.functions.ts`
- Replace: `tests/integration/lib/propresenter-api.server.test.ts`
- Test: `tests/unit/lib/propresenter-contract.test.ts`

- [ ] **Step 1: Add failing request-schema tests**

Append to `tests/unit/lib/propresenter-contract.test.ts`:

```ts
import { proPresenterRequestSchema } from "../../../src/lib/propresenter-request.ts";

test("request schema accepts only supported method and path pairs", () => {
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "GET",
      path: "/v1/presentation/active/next/trigger",
    }).success,
    true,
  );
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "PUT",
      path: "/v1/status/audience_screens",
      body: true,
    }).success,
    true,
  );
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "POST",
      path: "/v1/presentation/active/next/trigger",
    }).success,
    false,
  );
  assert.equal(
    proPresenterRequestSchema.safeParse({
      baseUrl: "http://localhost:50001",
      method: "GET",
      path: "/admin/not-propresenter",
    }).success,
    false,
  );
});
```

- [ ] **Step 2: Replace the integration test with failing transport coverage**

Replace `tests/integration/lib/propresenter-api.server.test.ts` with a local HTTP server covering:

```ts
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { requestProPresenter } from "../../../src/lib/propresenter-api.server.ts";

test("requestProPresenter forwards methods and JSON bodies and parses responses", async (t) => {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: req.method ?? "GET", url: req.url ?? "/", body });
      if (req.url === "/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "Booth", host_description: "ProPresenter 7.18", api_version: "v1" }));
        return;
      }
      if (req.url === "/v1/status/audience_screens" && req.method === "PUT") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === "/failure") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ProPresenter unavailable" }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const version = await requestProPresenter({ baseUrl, path: "/version", method: "GET" });
  const empty = await requestProPresenter({
    baseUrl,
    path: "/v1/status/audience_screens",
    method: "PUT",
    body: true,
  });

  assert.deepEqual(version, {
    name: "Booth",
    host_description: "ProPresenter 7.18",
    api_version: "v1",
  });
  assert.equal(empty, null);
  assert.deepEqual(calls, [
    { method: "GET", url: "/version", body: "" },
    { method: "PUT", url: "/v1/status/audience_screens", body: "true" },
  ]);

  await assert.rejects(
    requestProPresenter({ baseUrl, path: "/failure", method: "GET" }),
    /503.*ProPresenter unavailable/,
  );
});
```

- [ ] **Step 3: Run both tests and verify RED**

Run:

```powershell
node --test --experimental-strip-types tests/unit/lib/propresenter-contract.test.ts tests/integration/lib/propresenter-api.server.test.ts
```

Expected: FAIL because `propresenter-request.ts` is missing and PUT/body are unsupported.

- [ ] **Step 4: Implement the request schema**

Create `src/lib/propresenter-request.ts`:

```ts
import { z } from "zod";

import { CLEARABLE_LAYERS, PP_PATHS } from "./propresenter-contract.ts";

const staticGetPaths = new Set<string>([
  PP_PATHS.version,
  PP_PATHS.activePresentation,
  PP_PATHS.slideIndex,
  PP_PATHS.previous,
  PP_PATHS.next,
  PP_PATHS.audienceScreens,
]);
const clearPattern = new RegExp(`^/v1/clear/layer/(${CLEARABLE_LAYERS.join("|")})$`);
const timerPattern = /^\/v1\/timer\/[^/]+\/(start|stop|reset)$/;

export const proPresenterRequestSchema = z
  .object({
    baseUrl: z.string().url().regex(/^https?:\/\//i, "Base URL must use HTTP or HTTPS"),
    path: z.string().min(1).regex(/^\//, "Path must start with /").refine(
      (path) => staticGetPaths.has(path) || clearPattern.test(path) || timerPattern.test(path),
      "Unsupported ProPresenter endpoint",
    ),
    method: z.enum(["GET", "PUT"]),
    body: z.unknown().optional(),
  })
  .superRefine((request, context) => {
    const validPut = request.method === "PUT" && request.path === PP_PATHS.audienceScreens;
    const validGet = request.method === "GET" && request.body === undefined;
    if (!validPut && !validGet) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Method does not match endpoint" });
    }
    if (validPut && typeof request.body !== "boolean") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Audience screen body must be boolean" });
    }
  });

export type ProPresenterRequest = z.infer<typeof proPresenterRequestSchema>;
```

- [ ] **Step 5: Implement the transport and server function**

Replace `src/lib/propresenter-api.server.ts` with code that imports `ProPresenterRequest`, builds the URL, sends `Content-Type: application/json` only when a body exists, reads the response body once, and extracts `error` or `message` for non-2xx responses. The central request shape must be:

```ts
import type { ProPresenterRequest } from "./propresenter-request.ts";

function buildUrl(baseUrl: string, path: string) {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function parseText(text: string, contentType: string) {
  if (!text) return null;
  if (contentType.includes("application/json") || /^[\s]*[\[{]/.test(text)) {
    return JSON.parse(text);
  }
  return text;
}

function responseError(status: number, statusText: string, text: string) {
  let detail = text.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const candidate = parsed.error ?? parsed.message;
    if (typeof candidate === "string") detail = candidate;
  } catch {
    // Keep the plain-text response as the error detail.
  }
  return new Error([`${status} ${statusText}`.trim(), detail].filter(Boolean).join(": "));
}

export async function requestProPresenter(request: ProPresenterRequest) {
  const hasBody = request.body !== undefined;
  const response = await fetch(buildUrl(request.baseUrl, request.path), {
    method: request.method,
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });
  const text = response.status === 204 ? "" : await response.text();
  if (!response.ok) throw responseError(response.status, response.statusText, text);
  return parseText(text, response.headers.get("content-type") ?? "");
}
```

Replace the local schema in `src/lib/api/propresenter.functions.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";

import { requestProPresenter } from "../propresenter-api.server.ts";
import { proPresenterRequestSchema } from "../propresenter-request.ts";

export const propresenterRequest = createServerFn({ method: "POST" })
  .validator(proPresenterRequestSchema)
  .handler(async ({ data }) => requestProPresenter(data));
```

- [ ] **Step 6: Run both tests and verify GREEN**

Run the command from Step 3.

Expected: all contract and transport tests PASS.

- [ ] **Step 7: Commit the server boundary**

```powershell
git add src/lib/propresenter-request.ts src/lib/propresenter-api.server.ts src/lib/api/propresenter.functions.ts tests/unit/lib/propresenter-contract.test.ts tests/integration/lib/propresenter-api.server.test.ts
git commit --no-gpg-sign -m "fix: align ProPresenter server transport with OpenAPI"
```

### Task 3: Rebuild connection state and polling

**Files:**
- Modify: `src/lib/propresenter-client.ts`
- Replace: `tests/unit/lib/propresenter-client.test.ts`

- [ ] **Step 1: Write failing lifecycle and polling tests**

Replace `tests/unit/lib/propresenter-client.test.ts` with a request harness using documented payloads. Include these concrete assertions:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { PpClient, type PpTransportRequest } from "../../../src/lib/propresenter-client.ts";

const version = {
  name: "Sanctuary Mac",
  platform: "mac",
  os_version: "15.5",
  host_description: "ProPresenter 7.18.1",
  api_version: "v1",
};
const active = {
  presentation: {
    id: { uuid: "p1", name: "Sunday Service", index: 0 },
    groups: [{ name: "Main", color: "#fff", slides: [{}, {}, {}, {}] }],
  },
};
const slideIndex = { presentation_index: { index: 2, presentation_id: { uuid: "p1" } } };

function createHarness() {
  const calls: PpTransportRequest[] = [];
  const responses = new Map<string, unknown>([
    ["GET /version", version],
    ["GET /v1/presentation/active", active],
    ["GET /v1/presentation/slide_index", slideIndex],
  ]);
  let intervalCallback: (() => void) | undefined;
  const cleared: unknown[] = [];
  const client = new PpClient({
    request: async (request) => {
      calls.push(request);
      const key = `${request.method} ${request.path}`;
      const response = responses.get(key);
      if (response instanceof Error) throw response;
      if (!responses.has(key)) throw new Error(`Unhandled request: ${key}`);
      return response;
    },
    setIntervalFn: ((callback: () => void) => {
      intervalCallback = callback;
      return 41 as never;
    }) as typeof globalThis.setInterval,
    clearIntervalFn: ((id: unknown) => cleared.push(id)) as typeof globalThis.clearInterval,
  });
  return { client, calls, responses, cleared, runPoll: () => intervalCallback?.() };
}

test("connect maps official host and presentation state", async () => {
  const { client, calls } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001/" });
  assert.deepEqual(client.state, {
    connected: true,
    degraded: false,
    machineName: "Sanctuary Mac",
    hostDescription: "ProPresenter 7.18.1",
    apiVersion: "v1",
    activePresentationName: "Sunday Service",
    currentSlideIndex: 2,
    totalSlides: 4,
  });
  assert.equal(calls[0].baseUrl, "http://pp.example:50001");
});

test("a failed refresh preserves the last snapshot and marks degraded", async () => {
  const { client, responses } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001" });
  responses.set("GET /v1/presentation/active", new Error("connection refused"));
  await client.refresh();
  assert.equal(client.state.degraded, true);
  assert.equal(client.state.connected, true);
  assert.equal(client.state.activePresentationName, "Sunday Service");
  assert.match(client.state.refreshError ?? "", /connection refused/);
});

test("three failed refreshes mark offline and a success recovers", async () => {
  const { client, responses } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001" });
  responses.set("GET /v1/presentation/active", new Error("offline"));
  await client.refresh();
  await client.refresh();
  await client.refresh();
  assert.equal(client.state.connected, false);
  responses.set("GET /v1/presentation/active", active);
  await client.refresh();
  assert.equal(client.state.connected, true);
  assert.equal(client.state.degraded, false);
});

test("overlapping refresh calls share one in-flight request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let activeCalls = 0;
  const client = new PpClient({
    request: async (request) => {
      if (request.path === "/version") return version;
      if (request.path === "/v1/presentation/active") {
        activeCalls += 1;
        await gate;
        return active;
      }
      return slideIndex;
    },
    setIntervalFn: (() => 1 as never) as typeof globalThis.setInterval,
    clearIntervalFn: (() => {}) as typeof globalThis.clearInterval,
  });
  client.config = { baseUrl: "http://pp.example:50001" };
  const first = client.refresh();
  const second = client.refresh();
  release();
  await Promise.all([first, second]);
  assert.equal(activeCalls, 1);
});

test("disconnect clears polling and resets state", async () => {
  const { client, cleared } = createHarness();
  await client.connect({ baseUrl: "http://pp.example:50001" });
  client.disconnect();
  assert.deepEqual(cleared, [41]);
  assert.deepEqual(client.state, { connected: false, degraded: false });
});

test("a refresh that resolves after disconnect cannot restore stale state", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const client = new PpClient({
    request: async (request) => {
      if (request.path === "/v1/presentation/active") {
        await gate;
        return active;
      }
      return slideIndex;
    },
    setIntervalFn: (() => 1 as never) as typeof globalThis.setInterval,
    clearIntervalFn: (() => {}) as typeof globalThis.clearInterval,
  });
  client.config = { baseUrl: "http://pp.example:50001" };
  const refresh = client.refresh();
  client.disconnect();
  release();
  await refresh;
  assert.deepEqual(client.state, { connected: false, degraded: false });
});
```

- [ ] **Step 2: Run the client test and verify RED**

Run:

```powershell
node --test --experimental-strip-types tests/unit/lib/propresenter-client.test.ts
```

Expected: FAIL because current state fields, official parsing, degradation, and overlap control are missing.

- [ ] **Step 3: Implement the lifecycle state machine**

Rewrite `src/lib/propresenter-client.ts` around these exact public types and private fields:

```ts
import { propresenterRequest } from "./api/propresenter.functions.ts";
import {
  PP_PATHS,
  errorMessage,
  normalizeProPresenterBaseUrl,
  parseActivePresentation,
  parseSlideIndex,
  parseVersion,
  type PpPresentationSnapshot,
} from "./propresenter-contract.ts";
import type { ProPresenterRequest as PpTransportRequest } from "./propresenter-request.ts";

export type { PpTransportRequest };
export type PpConfig = { baseUrl: string };
export type PpActionGroup = "navigation" | "clear" | "timer";
export type PpState = PpPresentationSnapshot & {
  connected: boolean;
  degraded: boolean;
  machineName?: string;
  hostDescription?: string;
  apiVersion?: string;
  refreshError?: string;
  actionError?: string;
  activeAction?: PpActionGroup;
};
export const defaultPpState: PpState = { connected: false, degraded: false };

type PpClientDeps = {
  request?: (request: PpTransportRequest) => Promise<unknown>;
  setIntervalFn?: typeof globalThis.setInterval;
  clearIntervalFn?: typeof globalThis.clearInterval;
};

export class PpClient {
  config: PpConfig = { baseUrl: "" };
  state: PpState = { ...defaultPpState };
  private listeners = new Set<(state: PpState) => void>();
  private poll: ReturnType<typeof globalThis.setInterval> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private consecutiveRefreshFailures = 0;
  private generation = 0;
  private readonly request: (request: PpTransportRequest) => Promise<unknown>;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;

  constructor(deps: PpClientDeps = {}) {
    this.request = deps.request ?? ((request) => propresenterRequest({ data: request }));
    this.setIntervalFn = deps.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = deps.clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);
  }

  subscribe(listener: (state: PpState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<PpState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  private req(path: string, method: "GET" | "PUT" = "GET", body?: unknown) {
    return this.request({ baseUrl: this.config.baseUrl, path, method, body });
  }

  private stopPolling() {
    if (this.poll !== null) this.clearIntervalFn(this.poll);
    this.poll = null;
  }

  private startPolling() {
    this.stopPolling();
    this.poll = this.setIntervalFn(() => void this.refresh(), 1500);
  }
```

Complete `connect`, `disconnect`, and `refresh` with the approved rules:

```ts
  async connect(config: PpConfig) {
    this.stopPolling();
    const generation = ++this.generation;
    this.config = { baseUrl: normalizeProPresenterBaseUrl(config.baseUrl) };
    this.state = { ...defaultPpState };
    try {
      const host = parseVersion(await this.req(PP_PATHS.version));
      if (generation !== this.generation) return;
      this.update({ connected: true, ...host });
      await this.refresh();
      if (generation === this.generation) this.startPolling();
    } catch (error) {
      if (generation === this.generation) {
        this.update({ connected: false, refreshError: errorMessage(error, "Failed to connect") });
      }
      throw error;
    }
  }

  disconnect() {
    this.generation += 1;
    this.stopPolling();
    this.refreshPromise = null;
    this.consecutiveRefreshFailures = 0;
    this.state = { ...defaultPpState };
    this.listeners.forEach((listener) => listener(this.state));
  }

  refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const refreshPromise = (async () => {
      try {
        const [activePayload, indexPayload] = await Promise.all([
          this.req(PP_PATHS.activePresentation),
          this.req(PP_PATHS.slideIndex),
        ]);
        const active = parseActivePresentation(activePayload);
        const currentSlideIndex = parseSlideIndex(indexPayload);
        if (generation !== this.generation) return;
        this.consecutiveRefreshFailures = 0;
        this.update({
          connected: true,
          degraded: false,
          refreshError: undefined,
          ...active,
          currentSlideIndex,
        });
      } catch (error) {
        if (generation !== this.generation) return;
        this.consecutiveRefreshFailures += 1;
        this.update({
          connected: this.consecutiveRefreshFailures < 3,
          degraded: true,
          refreshError: errorMessage(error, "Could not refresh ProPresenter"),
        });
      }
    })();
    this.refreshPromise = refreshPromise;
    void refreshPromise.finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
    });
    return refreshPromise;
  }
```

Close the class temporarily after `refresh`, export `ppClient`, and leave action methods for Task 4.

- [ ] **Step 4: Run the client test and verify GREEN**

Run the command from Step 2.

Expected: lifecycle tests PASS.

- [ ] **Step 5: Commit polling and connection state**

```powershell
git add src/lib/propresenter-client.ts tests/unit/lib/propresenter-client.test.ts
git commit --no-gpg-sign -m "feat: rebuild ProPresenter connection state"
```

### Task 4: Add exact control actions and pending state

**Files:**
- Modify: `src/lib/propresenter-client.ts`
- Modify: `tests/unit/lib/propresenter-client.test.ts`

- [ ] **Step 1: Append failing action tests**

Add tests that install null responses for action paths and verify exact requests:

```ts
test("navigation uses the active-presentation OpenAPI paths and refreshes", async () => {
  const { client, calls, responses } = createHarness();
  responses.set("GET /v1/presentation/active/next/trigger", null);
  await client.connect({ baseUrl: "http://pp.example:50001" });
  calls.length = 0;
  await client.next();
  assert.deepEqual(calls.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/v1/presentation/active/next/trigger" },
    { method: "GET", path: "/v1/presentation/active" },
    { method: "GET", path: "/v1/presentation/slide_index" },
  ]);
  assert.equal(client.state.activeAction, undefined);
});

test("clearAll calls all seven documented clear layers", async () => {
  const { client, calls, responses } = createHarness();
  for (const layer of ["audio", "props", "messages", "announcements", "slide", "media", "video_input"]) {
    responses.set(`GET /v1/clear/layer/${layer}`, null);
  }
  client.config = { baseUrl: "http://pp.example:50001" };
  await client.clearAll();
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/v1/clear/layer/audio",
      "/v1/clear/layer/props",
      "/v1/clear/layer/messages",
      "/v1/clear/layer/announcements",
      "/v1/clear/layer/slide",
      "/v1/clear/layer/media",
      "/v1/clear/layer/video_input",
    ],
  );
});

test("timer operations path-encode the identifier", async () => {
  const { client, calls, responses } = createHarness();
  responses.set("GET /v1/timer/Service%20Timer/start", null);
  client.config = { baseUrl: "http://pp.example:50001" };
  await client.timerStart("Service Timer");
  assert.equal(calls[0].path, "/v1/timer/Service%20Timer/start");
});

test("failed actions expose an inline error and remain retryable", async () => {
  const { client, responses } = createHarness();
  responses.set("GET /v1/clear/layer/slide", new Error("clear rejected"));
  client.config = { baseUrl: "http://pp.example:50001" };
  await assert.rejects(client.clearSlide(), /clear rejected/);
  assert.equal(client.state.activeAction, undefined);
  assert.match(client.state.actionError ?? "", /clear rejected/);
  responses.set("GET /v1/clear/layer/slide", null);
  await client.clearSlide();
  assert.equal(client.state.actionError, undefined);
});
```

- [ ] **Step 2: Run the client test and verify RED**

Run the Task 3 client-test command.

Expected: FAIL because action methods and action state are absent.

- [ ] **Step 3: Implement the action runner and public controls**

Add imports for `CLEARABLE_LAYERS`, `buildClearLayerPath`, `buildTimerPath`, `ClearableLayer`, and `TimerOperation`. Add these methods before the class closes:

```ts
  private async runAction(
    group: PpActionGroup,
    operation: () => Promise<void>,
    refreshAfter = false,
  ) {
    if (this.state.activeAction === group) return;
    this.update({ activeAction: group, actionError: undefined });
    try {
      await operation();
      if (refreshAfter) await this.refresh();
    } catch (error) {
      this.update({ actionError: errorMessage(error, "ProPresenter command failed") });
      throw error;
    } finally {
      if (this.state.activeAction === group) this.update({ activeAction: undefined });
    }
  }

  previous() {
    return this.runAction("navigation", async () => {
      await this.req(PP_PATHS.previous);
    }, true);
  }

  next() {
    return this.runAction("navigation", async () => {
      await this.req(PP_PATHS.next);
    }, true);
  }

  clearLayer(layer: ClearableLayer) {
    return this.runAction("clear", async () => {
      await this.req(buildClearLayerPath(layer));
    });
  }

  clearSlide() { return this.clearLayer("slide"); }
  clearProps() { return this.clearLayer("props"); }
  clearMessages() { return this.clearLayer("messages"); }
  clearAudio() { return this.clearLayer("audio"); }
  clearAnnouncements() { return this.clearLayer("announcements"); }

  clearAll() {
    return this.runAction("clear", async () => {
      for (const layer of CLEARABLE_LAYERS) await this.req(buildClearLayerPath(layer));
    });
  }

  private timer(id: string, operation: TimerOperation) {
    return this.runAction("timer", async () => {
      await this.req(buildTimerPath(id, operation));
    }, true);
  }

  timerStart(id: string) { return this.timer(id, "start"); }
  timerStop(id: string) { return this.timer(id, "stop"); }
  timerReset(id: string) { return this.timer(id, "reset"); }
```

Do not restore `triggerIndex`, `toggleLogo`, or `audienceScreenToggle`; they are outside the approved UI surface.

- [ ] **Step 4: Run the client and contract tests and verify GREEN**

Run:

```powershell
node --test --experimental-strip-types tests/unit/lib/propresenter-contract.test.ts tests/unit/lib/propresenter-client.test.ts tests/integration/lib/propresenter-api.server.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 5: Commit control actions**

```powershell
git add src/lib/propresenter-client.ts tests/unit/lib/propresenter-client.test.ts
git commit --no-gpg-sign -m "feat: add reliable ProPresenter controls"
```

### Task 5: Redesign only the ProPresenter panel

**Required skill before this task:** `frontend-design`

**Files:**
- Modify: `src/components/ProPresenterPanel.tsx`
- Create: `tests/contract/propresenter-panel-contract.test.ts`

- [ ] **Step 1: Write failing UI contract tests**

Create `tests/contract/propresenter-panel-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(process.cwd(), "src/components/ProPresenterPanel.tsx"), "utf8");

test("ProPresenter panel renders connection and command feedback", () => {
  assert.match(source, /!s\.connected\s*\?\s*["']Offline["']/);
  assert.match(source, /s\.degraded\s*\?\s*["']Degraded["']/);
  assert.match(source, /s\.machineName/);
  assert.match(source, /s\.hostDescription/);
  assert.match(source, /s\.refreshError/);
  assert.match(source, /s\.actionError/);
  assert.match(source, /s\.activeAction\s*===\s*["']navigation["']/);
  assert.match(source, /s\.activeAction\s*===\s*["']clear["']/);
  assert.match(source, /s\.activeAction\s*===\s*["']timer["']/);
});

test("Clear All uses the shared confirmation dialog", () => {
  assert.match(source, /AlertDialogTrigger/);
  assert.match(source, /Clear all ProPresenter layers\?/);
  assert.match(source, /ppClient\.clearAll\(\)/);
});

test("panel keeps navigation, layer, and timer controls", () => {
  assert.match(source, /ppClient\.previous\(\)/);
  assert.match(source, /ppClient\.next\(\)/);
  assert.match(source, /ppClient\.clearSlide\(\)/);
  assert.match(source, /ppClient\.timerStart\(id\)/);
  assert.match(source, /Timer UUID, name, or index/);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```powershell
node --test --experimental-strip-types tests/contract/propresenter-panel-contract.test.ts
```

Expected: FAIL because degraded/pending/error states and confirmation are absent.

- [ ] **Step 3: Implement the ProPresenter-only panel redesign**

Keep the outer panel position and existing CSS variables. Replace console-only calls with a helper that relies on client state for visible errors:

```ts
const invoke = (operation: () => Promise<unknown>) => () => {
  void operation().catch(() => {});
};
const offline = !s.connected;
const statusLabel = !s.connected ? "Offline" : s.degraded ? "Degraded" : "Online";
const navigationPending = s.activeAction === "navigation";
const clearPending = s.activeAction === "clear";
const timerPending = s.activeAction === "timer";
```

The complete JSX structure must remain inside `ProPresenterPanel` and follow this hierarchy:

```tsx
<section className="glass flex h-full min-h-0 flex-col rounded-2xl p-4 sm:p-5">
  <header className="flex items-center justify-between gap-3">
    <div className="min-w-0">
      <h2 className="truncate text-sm font-semibold tracking-tight">ProPresenter</h2>
      <p className="truncate text-[11px] text-muted-foreground">
        {[s.machineName, s.hostDescription].filter(Boolean).join(" · ") || "REST API · :50001"}
      </p>
    </div>
    <span className="pill">{statusLabel}</span>
  </header>

  {s.refreshError && (
    <div role="status" className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      {s.refreshError}
    </div>
  )}
  {s.actionError && (
    <div role="alert" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {s.actionError}
    </div>
  )}

  <div className="mt-4 rounded-xl border border-border p-4" style={{ background: "color-mix(in oklab, var(--pp) 8%, var(--card))" }}>
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Active Presentation</div>
    <div className="mt-1 truncate text-base font-bold">
      {s.activePresentationName || (s.connected ? "No active presentation" : "Not connected")}
    </div>
    <div className="mt-1 font-mono text-xs text-muted-foreground">
      Slide {typeof s.currentSlideIndex === "number" ? s.currentSlideIndex + 1 : "—"}
      {typeof s.totalSlides === "number" ? ` of ${s.totalSlides}` : ""}
    </div>
  </div>

  <div className="mt-3 grid grid-cols-2 gap-2">
    <button onClick={invoke(() => ppClient.previous())} disabled={offline || navigationPending}>Previous</button>
    <button onClick={invoke(() => ppClient.next())} disabled={offline || navigationPending}>Next</button>
  </div>

  <div className="mt-4">
    <h3>Clear Layers</h3>
    <div className="grid grid-cols-3 gap-2">
      <ClearBtn onClick={invoke(() => ppClient.clearSlide())} disabled={offline || clearPending} icon={<Layers className="h-4 w-4" />} label="Slide" />
      <ClearBtn onClick={invoke(() => ppClient.clearProps())} disabled={offline || clearPending} icon={<Image className="h-4 w-4" />} label="Props" />
      <ClearBtn onClick={invoke(() => ppClient.clearMessages())} disabled={offline || clearPending} icon={<MessageSquare className="h-4 w-4" />} label="Msgs" />
      <ClearBtn onClick={invoke(() => ppClient.clearAudio())} disabled={offline || clearPending} icon={<Music className="h-4 w-4" />} label="Audio" />
      <ClearBtn onClick={invoke(() => ppClient.clearAnnouncements())} disabled={offline || clearPending} icon={<MessageSquare className="h-4 w-4" />} label="Annc" />
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button disabled={offline || clearPending}>Clear All</button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all ProPresenter layers?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears audio, props, messages, announcements, slides, media, and video inputs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={invoke(() => ppClient.clearAll())}>Clear all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  </div>

  <TimerControls disabled={offline || timerPending} />
</section>
```

Preserve the existing `ClearBtn` implementation and touch target sizing. Import all AlertDialog exports from `@/components/ui/alert-dialog`. Update `TimerControls` to use the input hint `Timer UUID, name, or index`, trim the identifier before sending, and use the shared `invoke` pattern rather than `console.error`.

- [ ] **Step 4: Run the UI contract and full contract suite**

Run:

```powershell
npm.cmd run test:contract
```

Expected: all contract tests PASS.

- [ ] **Step 5: Commit the ProPresenter panel**

```powershell
git add src/components/ProPresenterPanel.tsx tests/contract/propresenter-panel-contract.test.ts
git commit --no-gpg-sign -m "feat: improve ProPresenter remote feedback"
```

### Task 6: Improve only the ProPresenter connection subsection

**Files:**
- Modify: `src/components/ConnectionSettings.tsx`
- Modify: `tests/contract/connection-settings-contract.test.ts`

- [ ] **Step 1: Add failing preservation and status assertions**

Append to `tests/contract/connection-settings-contract.test.ts`:

```ts
test("ConnectionSettings validates and reports ProPresenter connection state", () => {
  const source = readSource("src/components/ConnectionSettings.tsx");
  assert.match(source, /normalizeProPresenterBaseUrl/);
  assert.match(source, /ppClient\.subscribe/);
  assert.match(source, /Connected to/);
  assert.match(source, /ppState\.degraded/);
});

test("OBS connection controls remain present and independent", () => {
  const source = readSource("src/components/ConnectionSettings.tsx");
  assert.match(source, /await obsClient\.connect\(\{ url: cfg\.obsUrl, password: cfg\.obsPassword \}\)/);
  assert.match(source, /Connect OBS/);
  assert.match(source, /OBS WebSocket/);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```powershell
node --test --experimental-strip-types tests/contract/connection-settings-contract.test.ts
```

Expected: FAIL because URL normalization and subscribed status are absent.

- [ ] **Step 3: Add ProPresenter connection state without changing OBS**

Import `PpState`, `defaultPpState`, and `normalizeProPresenterBaseUrl`. Add state and subscription:

```ts
const [ppState, setPpState] = useState<PpState>(defaultPpState);

useEffect(() => {
  const unsubscribe = ppClient.subscribe(setPpState);
  return () => {
    unsubscribe();
  };
}, []);
```

Normalize before connecting and surface validation through the existing `ppErr`:

```ts
const connectPp = async () => {
  setBusy("pp");
  setPpErr(undefined);
  try {
    const baseUrl = normalizeProPresenterBaseUrl(cfg.ppUrl);
    save({ ...cfg, ppUrl: baseUrl });
    await ppClient.connect({ baseUrl });
  } catch (error) {
    setPpErr(error instanceof Error ? error.message : "Failed to connect");
  } finally {
    setBusy(null);
  }
};
```

Inside only the ProPresenter card, below the input, render:

```tsx
{ppState.connected && (
  <p className="mt-2 text-xs" style={{ color: "var(--pp)" }}>
    Connected to {ppState.machineName || "ProPresenter"}
    {ppState.degraded ? " · Degraded" : ""}
  </p>
)}
{ppErr && <p role="alert" className="mt-2 text-xs text-destructive">{ppErr}</p>}
```

Do not edit the OBS card markup or `connectObs` implementation.

- [ ] **Step 4: Run contract and focused ProPresenter tests**

Run:

```powershell
npm.cmd run test:contract
node --test --experimental-strip-types tests/unit/lib/propresenter-contract.test.ts tests/unit/lib/propresenter-client.test.ts tests/integration/lib/propresenter-api.server.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit connection UX**

```powershell
git add src/components/ConnectionSettings.tsx tests/contract/connection-settings-contract.test.ts
git commit --no-gpg-sign -m "feat: improve ProPresenter connection feedback"
```

### Task 7: Verify scope and production readiness

**Files:**
- Modify only if verification exposes a ProPresenter-specific defect in files listed by this plan.

- [ ] **Step 1: Confirm no OBS implementation changed**

Run:

```powershell
git diff --name-only 9a2832b..HEAD
```

Expected: no `src/lib/obs-*`, `src/components/ObsPanel.tsx`, `src/routes/index.tsx`, or OBS test files.

- [ ] **Step 2: Run the complete automated test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Run lint**

Run:

```powershell
npm.cmd run lint
```

Expected: exit code 0. If the repository already has unrelated lint failures, record the exact pre-existing failures and verify no failure points to a changed ProPresenter file.

- [ ] **Step 4: Run the production build**

Run:

```powershell
npm.cmd run build
```

Expected: client and SSR builds complete successfully.

- [ ] **Step 5: Verify the ProPresenter panel in the browser**

Use the `browser:control-in-app-browser` skill. Start the dev server with:

```powershell
npm.cmd run dev
```

At `http://localhost:5173`, verify at desktop and narrow-tablet widths:

- the OBS panel and dashboard placement are unchanged;
- the disconnected ProPresenter panel remains readable;
- Connect ProPresenter validates malformed URLs inline;
- failed connections show an inline error;
- navigation remains the dominant control group;
- Clear All opens the confirmation dialog and Cancel closes it;
- timer controls remain usable without horizontal overflow.

- [ ] **Step 6: Commit only if verification required a fix**

If a ProPresenter-specific fix was necessary:

```powershell
git add src/lib/propresenter-contract.ts src/lib/propresenter-request.ts src/lib/propresenter-api.server.ts src/lib/api/propresenter.functions.ts src/lib/propresenter-client.ts src/components/ProPresenterPanel.tsx src/components/ConnectionSettings.tsx tests/unit/lib/propresenter-contract.test.ts tests/unit/lib/propresenter-client.test.ts tests/integration/lib/propresenter-api.server.test.ts tests/contract/propresenter-panel-contract.test.ts tests/contract/connection-settings-contract.test.ts
git commit --no-gpg-sign -m "fix: address ProPresenter verification findings"
```

If no fix was required, do not create an empty commit.

---

## Implementation Completion Checklist

- [ ] Official `/version`, active-presentation, and slide-index payloads parse correctly.
- [ ] Navigation, layer clearing, Clear All, and timers use documented GET endpoints.
- [ ] Transport supports validated GET and PUT requests with optional JSON bodies.
- [ ] Polling cannot overlap, leak, or overwrite disconnected state.
- [ ] Three failed refreshes mark offline and a successful refresh recovers.
- [ ] Pending and error feedback is visible in the ProPresenter panel.
- [ ] Clear All requires confirmation.
- [ ] Only the ProPresenter subsection of Connection Settings changes.
- [ ] OBS implementation, OBS UI, and dashboard composition remain unchanged.
- [ ] Focused tests, full tests, lint, build, and browser checks pass.
