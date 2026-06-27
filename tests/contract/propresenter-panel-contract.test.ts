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
  assert.match(source, /ppClient\.timerStart\(id\.trim\(\)\)/);
  assert.match(source, /Timer UUID, name, or index/);
});
