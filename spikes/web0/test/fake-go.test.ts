import test from "node:test";
import assert from "node:assert/strict";
import { goRequestPayload, startFakeGo } from "../ts-core/fake-go.ts";

test("fake Go returns deterministic 8/16/12 KiB responses with 200 ms delay", async () => {
  const fake = await startFakeGo();
  try {
    const sizes = [12 * 1024, 24 * 1024, 28 * 1024];
    const expected = [8 * 1024, 16 * 1024, 12 * 1024];
    for (let index = 0; index < 3; index += 1) {
      const payload = goRequestPayload(index + 1, sizes[index] ?? 0);
      assert.equal(Buffer.byteLength(payload, "utf8"), sizes[index]);
      const started = performance.now();
      const response = await fetch(fake.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const text = await response.text();
      const elapsed = performance.now() - started;
      assert.equal(response.status, 200);
      assert.equal(Buffer.byteLength(text, "utf8"), expected[index]);
      assert.ok(elapsed >= 190, `elapsed=${elapsed}`);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      assert.equal(parsed.model, "opencode-go/synthetic-model");
    }
    assert.equal(fake.stats.requests, 3);
    assert.equal(fake.stats.requestBytes, sizes.reduce((sum, size) => sum + size, 0));
    assert.equal(fake.stats.responseBytes, expected.reduce((sum, size) => sum + size, 0));
    assert.deepEqual(
      fake.stats.calls.map((call) => call.requestBytes),
      sizes,
    );
  } finally {
    await fake.stop();
  }
});
