import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

test("dashboard grid can shrink enough for nested panels to scroll", () => {
  const routeSource = readSource("src/routes/index.tsx");

  assert.match(routeSource, /className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2"/);
});

test("viewport background is locked while the app shell owns scrolling", () => {
  const stylesSource = readSource("src/styles.css");
  const routeSource = readSource("src/routes/index.tsx");

  assert.match(stylesSource, /html,\s*body\s*\{\s*height:\s*100%;\s*overflow:\s*hidden;\s*\}/);
  assert.match(
    routeSource,
    /className="mx-auto flex h-\[100dvh\] max-w-\[1400px\] flex-col gap-3 overflow-y-auto p-3 sm:p-5"/,
  );
});

test("control panels opt into min-height shrinking for scroll regions", () => {
  const obsPanelSource = readSource("src/components/ObsPanel.tsx");
  const proPresenterPanelSource = readSource("src/components/ProPresenterPanel.tsx");

  assert.match(
    obsPanelSource,
    /className="glass flex h-full min-h-0 flex-col rounded-2xl p-4 sm:p-5"/,
  );
  assert.match(
    proPresenterPanelSource,
    /className="glass flex h-full min-h-0 flex-col rounded-2xl p-4 sm:p-5"/,
  );
});

test("OBS panel keeps scenes in a dense matrix without search or pin workflows", () => {
  const obsPanelSource = readSource("src/components/ObsPanel.tsx");

  assert.match(obsPanelSource, /Scene Matrix/);
  assert.doesNotMatch(obsPanelSource, /Quick Switch/);
  assert.doesNotMatch(obsPanelSource, /Filter scenes/);
  assert.doesNotMatch(obsPanelSource, /Pin the scenes/);
  assert.match(obsPanelSource, /className="mt-4 flex min-h-0 flex-1 flex-col"/);
  assert.match(
    obsPanelSource,
    /grid h-full auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4/,
  );
});
