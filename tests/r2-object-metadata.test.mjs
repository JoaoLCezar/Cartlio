import assert from "node:assert/strict";
import { test } from "node:test";
import { createR2ObjectMetadataReader } from "../scripts/lib/r2-object-metadata.mjs";

const env = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "fake-access-key",
  R2_SECRET_ACCESS_KEY: "fake-secret",
  R2_BUCKET: "quadrics-test",
};
const reservation = {
  storage_provider: "r2",
  tenant_id: "10000000-0000-4000-8000-000000000001",
  gallery_id: "10000000-0000-4000-8000-000000000002",
  id: "10000000-0000-4000-8000-000000000003",
  byte_size: 128,
  content_type: "image/png",
};
reservation.object_path = `${reservation.tenant_id}/${reservation.gallery_id}/${reservation.id}.png`;

function mockReader(statusCode, headers = {}, config = env) {
  const requests = [];
  const read = createR2ObjectMetadataReader(config, {
    requestHandler: {
      async handle(request, options) {
        requests.push({ request, options });
        return { response: { statusCode, headers } };
      },
    },
  });
  return { read, requests };
}

test("R2 metadata reads the reserved key using a signed HEAD request", async () => {
  const { read, requests } = mockReader(200, {
    "content-length": "128",
    "content-type": "image/png",
    etag: '"fake-etag"',
  });
  assert.deepEqual(await read(reservation), {
    provider: "r2",
    path: reservation.object_path,
    byteSize: 128,
    contentType: "image/png",
    etag: '"fake-etag"',
  });
  assert.equal(requests.length, 1);
  const [{ request, options }] = requests;
  assert.equal(request.method, "HEAD");
  assert.equal(request.hostname, `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.equal(request.path, `/${env.R2_BUCKET}/${reservation.object_path}`);
  assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.ok(options.abortSignal instanceof AbortSignal);
});

test("R2 metadata rejects unsupported providers and out-of-scope keys before a request", async () => {
  const { read, requests } = mockReader(200);
  await assert.rejects(read({ ...reservation, storage_provider: "supabase" }), { message: "UPLOAD_PROVIDER_UNSUPPORTED" });
  await assert.rejects(read({ ...reservation, object_path: "another-workspace/foto.png" }), { message: "UPLOAD_MISMATCH" });
  await assert.rejects(read({ ...reservation, object_path: reservation.object_path.replace(/\.png$/, ".jpg") }), { message: "UPLOAD_MISMATCH" });
  assert.equal(requests.length, 0);
});

test("R2 metadata distinguishes a missing object from permission and connection errors", async () => {
  assert.equal(await mockReader(404).read(reservation), null);
  for (const status of [403, 503]) {
    await assert.rejects(mockReader(status).read(reservation), { message: "R2_METADATA_UNAVAILABLE" });
  }
  const read = createR2ObjectMetadataReader(env, {
    requestHandler: { async handle() { throw new Error("provider details"); } },
  });
  await assert.rejects(read(reservation), { message: "R2_METADATA_UNAVAILABLE" });
});

test("R2 metadata rejects wrong sizes, wrong types and missing headers", async () => {
  for (const headers of [
    { "content-length": "129", "content-type": "image/png" },
    { "content-length": "128", "content-type": "image/jpeg" },
    { "content-length": "128" },
    { "content-type": "image/png" },
  ]) {
    await assert.rejects(mockReader(200, headers).read(reservation), { message: "UPLOAD_MISMATCH" });
  }
});

test("R2 metadata requires an explicit account, bucket and credentials", () => {
  for (const config of [{}, { ...env, R2_ACCOUNT_ID: "localhost" }, { ...env, R2_BUCKET: "../invalid" }, { ...env, R2_SECRET_ACCESS_KEY: "" }]) {
    assert.throws(() => createR2ObjectMetadataReader(config), { message: "R2_STORAGE_NOT_CONFIGURED" });
  }
});
