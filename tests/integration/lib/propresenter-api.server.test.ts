import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { requestProPresenter } from "../../../src/lib/propresenter-api.server.ts";

test("requestProPresenter forwards ProPresenter requests and tolerates empty action responses", async (t) => {
  const calls: Array<{ method: string; url: string }> = [];
  const server = http.createServer((req, res) => {
    calls.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
    });

    if (req.url === "/version") {
      const body = JSON.stringify({ version: "ProPresenter 7.18" });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (req.method === "POST" && req.url === "/v1/trigger/next") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an IPv4 listening address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const version = await requestProPresenter({
    baseUrl,
    path: "/version",
    method: "GET",
  });
  const action = await requestProPresenter({
    baseUrl,
    path: "/v1/trigger/next",
    method: "POST",
  });

  assert.deepEqual(version, { version: "ProPresenter 7.18" });
  assert.equal(action, null);
  assert.deepEqual(calls, [
    {
      method: "GET",
      url: "/version",
    },
    {
      method: "POST",
      url: "/v1/trigger/next",
    },
  ]);
});
