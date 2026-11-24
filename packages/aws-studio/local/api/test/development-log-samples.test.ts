import assert from "node:assert/strict";
import test from "node:test";
import { developmentBodySample } from "../lib/developmentLogs";

test("stream samples count omitted auth/binary/unknown bytes and retain useful bounded JSON", () => {
  const body = Buffer.from('{"proof":"SAMPLE_AUTH_CANARY"}');
  for (const [contentType, sensitive] of [
    ["application/json", true],
    ["application/octet-stream", false],
    [undefined, false],
  ] as const) {
    const sample = developmentBodySample(contentType, sensitive);
    for (let index = 0; index < 100; index++) sample.push(body);
    const result = sample.preview();
    assert.equal(result.bytes, body.length * 100);
    assert.match(JSON.stringify(result.preview), /omitted/);
    assert.ok(!JSON.stringify(result).includes("SAMPLE_AUTH_CANARY"));
  }
  const ordinary = developmentBodySample("application/json", false);
  ordinary.push('{"message":"visible');
  ordinary.push(Buffer.alloc(0));
  ordinary.push(' sample","token":"SAMPLE_TOKEN_CANARY"}');
  assert.ok(JSON.stringify(ordinary.preview()).includes("visible sample"));
  assert.ok(
    !JSON.stringify(ordinary.preview()).includes("SAMPLE_TOKEN_CANARY"),
  );
  const large = developmentBodySample("text/plain", false);
  large.push("x".repeat(65537));
  assert.match(JSON.stringify(large.preview()), /oversized/);
});
