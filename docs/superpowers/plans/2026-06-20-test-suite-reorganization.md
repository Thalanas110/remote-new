# Test Suite Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every test out of `src/` into a top-level `tests/` tree with clear category boundaries and update the Node test scripts to match.

**Architecture:** Keep the existing Node built-in test runner and `--experimental-strip-types` flow, but reorganize files into `tests/contract`, `tests/unit`, and `tests/integration`. Preserve current test behavior by only changing file paths, import paths, and package scripts, plus one organization contract test that locks the new layout in place.

**Tech Stack:** TypeScript, Node built-in test runner, npm scripts

---

## File Structure

- Create: `tests/contract/test-suite-organization.test.ts`
  Purpose: enforce the new `tests/` layout and package script conventions.
- Move: `src/layout.scroll-contract.test.ts` -> `tests/contract/layout.scroll-contract.test.ts`
  Purpose: keep source/layout invariants in the contract bucket.
- Move: `src/lib/obs-scene-guard.test.ts` -> `tests/unit/lib/obs-scene-guard.test.ts`
  Purpose: keep pure library logic in unit tests.
- Move: `src/lib/propresenter-client.test.ts` -> `tests/unit/lib/propresenter-client.test.ts`
  Purpose: keep isolated client transport behavior in unit tests.
- Move: `src/lib/obs-client.remote-studio.test.ts` -> `tests/integration/lib/obs-client.remote-studio.test.ts`
  Purpose: keep multi-step fake transport/state workflows in integration tests.
- Move: `src/lib/propresenter-api.server.test.ts` -> `tests/integration/lib/propresenter-api.server.test.ts`
  Purpose: keep HTTP forwarding behavior in integration tests.
- Modify: `package.json`
  Purpose: add normalized `test`, `test:contract`, `test:unit`, and `test:integration` scripts that target the new tree.

## Tasks

### Task 1: Add The Red Organization Contract

**Files:**
- Create: `tests/contract/test-suite-organization.test.ts`
- Test: `tests/contract/test-suite-organization.test.ts`

- [ ] Write a source-level contract test that reads `package.json`, asserts the presence of `test`, `test:contract`, `test:unit`, and `test:integration` scripts referencing `tests/`, and asserts that no `src/**/*.test.ts` files remain.
- [ ] Run `node --test --experimental-strip-types tests/contract/test-suite-organization.test.ts` and verify it fails against the current layout.

### Task 2: Move And Rewire The Tests

**Files:**
- Move: `src/layout.scroll-contract.test.ts` -> `tests/contract/layout.scroll-contract.test.ts`
- Move: `src/lib/obs-scene-guard.test.ts` -> `tests/unit/lib/obs-scene-guard.test.ts`
- Move: `src/lib/propresenter-client.test.ts` -> `tests/unit/lib/propresenter-client.test.ts`
- Move: `src/lib/obs-client.remote-studio.test.ts` -> `tests/integration/lib/obs-client.remote-studio.test.ts`
- Move: `src/lib/propresenter-api.server.test.ts` -> `tests/integration/lib/propresenter-api.server.test.ts`

- [ ] Move each test into its category directory under `tests/`.
- [ ] Update relative imports inside moved tests so they still target `src/lib/...` correctly.
- [ ] Leave test logic unchanged unless a path update is required.

### Task 3: Normalize Test Commands

**Files:**
- Modify: `package.json`

- [ ] Add `test`, `test:contract`, `test:unit`, and `test:integration` scripts that execute the categorized files from `tests/`.
- [ ] Update or replace the old ad-hoc scripts so they no longer point at `src/...test.ts`.

### Task 4: Verify The Reorganization

**Files:**
- Test: `tests/contract/test-suite-organization.test.ts`
- Test: `tests/contract/layout.scroll-contract.test.ts`
- Test: `tests/unit/lib/obs-scene-guard.test.ts`
- Test: `tests/unit/lib/propresenter-client.test.ts`
- Test: `tests/integration/lib/obs-client.remote-studio.test.ts`
- Test: `tests/integration/lib/propresenter-api.server.test.ts`

- [ ] Run the red organization contract again and verify it passes.
- [ ] Run `npm test` and verify the whole suite passes from the new layout.
- [ ] Run `npm run build` and verify the build still passes after the path changes.

## Self-Review

### Spec Coverage

- Top-level `tests/` directory: covered by Tasks 1 and 2.
- Category buckets: covered by Task 2.
- Proper framework-like scripts: covered by Task 3.
- Verification of the new convention: covered by Task 4.

### Placeholder Scan

- No placeholders remain.
- Every changed file and verification command is explicit.

### Type Consistency

- Categories are consistently `contract`, `unit`, and `integration`.
- Test file targets stay aligned with the source files they exercise.
