import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

test("ConnectionSettings uses the documented ProPresenter API default port", () => {
  const source = readSource("src/components/ConnectionSettings.tsx");

  assert.match(source, /ppUrl: "http:\/\/127\.0\.0\.1:50001"/);
  assert.match(source, /placeholder="http:\/\/192\.168\.1\.20:50001"/);
  assert.match(source, /network access to the\s+ProPresenter host on port 50001/);
});

test("ConnectionSettings validates and reports ProPresenter connection state", () => {
  const source = readSource("src/components/ConnectionSettings.tsx");
  assert.match(source, /normalizeProPresenterBaseUrl/);
  assert.match(source, /ppClient\.subscribe/);
  assert.match(source, /Connected to/);
  assert.match(source, /ppState\.degraded/);
});

test("OBS connection controls remain present and independent", () => {
  const source = readSource("src/components/ConnectionSettings.tsx");
  assert.match(
    source,
    /await obsClient\.connect\(\{ url: cfg\.obsUrl, password: cfg\.obsPassword \}\)/,
  );
  assert.match(source, /Connect OBS/);
  assert.match(source, /OBS WebSocket/);
});
