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
        res.end(
          JSON.stringify({
            name: "Booth",
            host_description: "ProPresenter 7.18",
            api_version: "v1",
          }),
        );
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
