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
