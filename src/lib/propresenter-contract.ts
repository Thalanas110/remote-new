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
