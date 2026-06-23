export type ProPresenterRequest = {
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
};

function buildUrl(baseUrl: string, path: string) {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function looksLikeJson(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export async function requestProPresenter({
  baseUrl,
  path,
  method,
}: ProPresenterRequest) {
  const response = await fetch(buildUrl(baseUrl, path), {
    method,
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || looksLikeJson(text)) {
    return JSON.parse(text);
  }

  return text;
}
