import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

function readPackageJson() {
  return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
}

function collectTestFiles(rootPath: string) {
  const entries = readdirSync(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(relative(process.cwd(), absolutePath).replace(/\\/g, "/"));
    }
  }

  return files.sort();
}

test("package scripts target the categorized tests tree", () => {
  const packageJson = readPackageJson();
  const scripts = packageJson.scripts ?? {};

  assert.match(scripts.test ?? "", /tests\//);
  assert.match(scripts["test:contract"] ?? "", /tests\/contract\//);
  assert.match(scripts["test:unit"] ?? "", /tests\/unit\//);
  assert.match(scripts["test:integration"] ?? "", /tests\/integration\//);
});

test("source tree no longer stores test files", () => {
  const srcTests = collectTestFiles(join(process.cwd(), "src"));

  assert.deepEqual(srcTests, []);
});
