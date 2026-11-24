import assert from "./support/assert";
import { test } from "node:test";
import { IconImageCache } from "../src/icon-images";

function fixture(complete = false, naturalWidth = 0) {
  let decoded!: () => void;
  let rejectDecode!: () => void;
  const image = {
    src: "", fetchPriority: "auto", complete, naturalWidth,
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    decode: () => new Promise<void>((resolve, reject) => { decoded = resolve; rejectDecode = reject; }),
  };
  let created = 0;
  const cache = new IconImageCache(() => { created++; return image as unknown as HTMLImageElement; });
  return { image, cache, created: () => created, decode: () => decoded(), reject: () => rejectDecode() };
}

test("shared URL entries start high priority and wait for SVG decoding", async () => {
  const f = fixture();
  const first = f.cache.get("/icons/aws/lambda.svg");
  assert.equal(f.cache.get("/icons/aws/lambda.svg"), first);
  assert.equal(f.created(), 1);
  assert.equal(f.image.fetchPriority, "high");
  assert.equal(f.image.src, "/icons/aws/lambda.svg");
  assert.equal(first.settled, false);
  f.image.naturalWidth = 64;
  f.image.onload!();
  assert.equal(first.settled, false, "receiving bytes is not sufficient for the canvas");
  f.decode();
  await first.ready;
  assert.equal(first.settled, true);
  assert.equal(f.image.onload, null);
  assert.equal(f.image.onerror, null);
  assert.equal(f.cache.get("/icons/aws/lambda.svg"), first, "remounts reuse the decoded image");
});

test("failed loads and failed decodes release scene readiness", async () => {
  const failed = fixture();
  const first = failed.cache.get("/missing.svg");
  failed.image.onerror!();
  await first.ready;
  assert.equal(first.settled, true);

  const invalid = fixture();
  const second = invalid.cache.get("/invalid.svg");
  invalid.image.naturalWidth = 64;
  invalid.image.onload!();
  invalid.reject();
  await second.ready;
  assert.equal(second.settled, true);
});

test("already complete cached images decode and broken cached images settle", async () => {
  const cached = fixture(true, 64);
  const first = cached.cache.get("/cached.svg");
  assert.equal(first.settled, false);
  cached.decode();
  await first.ready;
  assert.equal(first.settled, true);

  const broken = fixture(true);
  const second = broken.cache.get("/broken.svg");
  await second.ready;
  assert.equal(second.settled, true);
});
