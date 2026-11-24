import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createR2OriginalAccess } from "../scripts/lib/r2-originals.mjs";

const env = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "fake-access-key",
  R2_SECRET_ACCESS_KEY: "fake-secret",
  R2_BUCKET: "quadrics-test",
};
const photo = {
  storage_provider: "r2",
  tenant_id: "10000000-0000-4000-8000-000000000001",
  gallery_id: "10000000-0000-4000-8000-000000000002",
  id: "10000000-0000-4000-8000-000000000003",
  byte_size: 4,
  content_type: "image/png",
  storage_etag: '"original-1"',
};
photo.object_path = `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.png`;

function mockAccess({ statusCode = 200, headers = {}, body = [Buffer.from([1, 2]), Buffer.from([3, 4])] } = {}) {
  const requests = [];
  const access = createR2OriginalAccess(env, {
    requestHandler: {
      async handle(request) {
        requests.push(request);
        return { response: {
          statusCode,
          headers: { "content-length": "4", "content-type": "image/png", etag: photo.storage_etag, ...headers },
          body: body instanceof Readable ? body : Readable.from(body),
        } };
      },
    },
  });
  return { access, requests };
}

test("R2 PUT signature requires create-only, the reserved content type and the exact size", async () => {
  const { access, requests } = mockAccess();
  const signed = await access.signUpload({
    ...photo, state: "reserved", expires_at: new Date(Date.now() + 120_000).toISOString(),
    r2_put_authorized_at: new Date().toISOString(),
  });
  const url = new URL(signed.url);
  assert.equal(url.host, `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname, `/${env.R2_BUCKET}/${photo.object_path}`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders").split(";");
  for (const header of ["if-none-match", "content-type", "content-length"]) assert.ok(signedHeaders.includes(header), header);
  assert.equal(signed.method, "PUT");
  assert.deepEqual(signed.headers, { "Content-Type": "image/png", "If-None-Match": "*" });
  assert.deepEqual(requests, []);
});

test("R2 PUT expires before the reservation and rejects closed or oversized uploads", async () => {
  const { access } = mockAccess();
  const reservation = {
    ...photo, state: "reserved", expires_at: new Date(Date.now() + 30_000).toISOString(),
    r2_put_authorized_at: new Date().toISOString(),
  };
  const signed = await access.signUpload(reservation);
  assert.ok(Number(new URL(signed.url).searchParams.get("X-Amz-Expires")) <= 30);
  await assert.rejects(access.signUpload({ ...reservation, expires_at: new Date(0).toISOString() }), { message: "UPLOAD_CLOSED" });
  await assert.rejects(access.signUpload({ ...reservation, state: "canceling" }), { message: "UPLOAD_CLOSED" });
  await assert.rejects(access.signUpload({ ...reservation, byte_size: 50 * 1024 * 1024 + 1 }), { message: "UPLOAD_MISMATCH" });
  await assert.rejects(access.signUpload({ ...reservation, r2_put_authorized_at: null }), { message: "UPLOAD_CONFIRMATION_DENIED" });
});

test("R2 GET requires the recorded ETag and returns exactly the reserved number of bytes", async () => {
  const { access, requests } = mockAccess();
  assert.deepEqual(await access.readVerifiedOriginal(photo), Buffer.from([1, 2, 3, 4]));
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers["if-match"], photo.storage_etag);
  assert.equal(requests[0].path, `/${env.R2_BUCKET}/${photo.object_path}`);
  for (const storage_etag of [null, "*", 'W/"weak"']) {
    await assert.rejects(access.readVerifiedOriginal({ ...photo, storage_etag }), { message: "UPLOAD_MISMATCH" });
  }
  assert.equal(requests.length, 1);
});

test("R2 GET blocks replacements, oversized bodies and incomplete reads", async () => {
  for (const options of [
    { statusCode: 412, body: [] },
    { headers: { etag: '"different"' } },
    { headers: { "content-length": "5" } },
    { headers: { "content-type": "image/jpeg" } },
    { body: [Buffer.alloc(5)] },
  ]) {
    await assert.rejects(mockAccess(options).access.readVerifiedOriginal(photo), { message: "R2_ORIGINAL_CHANGED" });
  }
  await assert.rejects(mockAccess({ body: [Buffer.alloc(3)] }).access.readVerifiedOriginal(photo), { message: "R2_ORIGINAL_UNAVAILABLE" });
});

test("canceling a download before consuming its stream closes the upstream body", async () => {
  const upstream = Readable.from([Buffer.from([1, 2, 3, 4])]);
  const { access } = mockAccess({ body: upstream });
  const stream = await access.openVerifiedOriginal(photo);
  const responseBody = Readable.toWeb(stream);
  await responseBody.cancel();
  await new Promise(resolve => stream.closed ? resolve() : stream.once("close", resolve));
  assert.equal(upstream.destroyed, true);
});
