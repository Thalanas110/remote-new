import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

test("ObsPanel passes guard state into each scene button", () => {
  const source = readSource("src/components/ObsPanel.tsx");

  assert.match(source, /guardState=\{s\.sceneGuard\[sceneName\]\}/);
});

test("ObsPanel renders a WARN badge for flagged non-program scenes", () => {
  const source = readSource("src/components/ObsPanel.tsx");

  assert.match(source, /label="WARN"/);
  assert.match(source, /const flagged = guardState\?\.status === "flagged"/);
});

test("scene guard reason labels include Frozen source and Laggy source", () => {
  const source = readSource("src/lib/obs-scene-guard.ts");

  assert.match(source, /"Frozen source"/);
  assert.match(source, /"Laggy source"/);
});
