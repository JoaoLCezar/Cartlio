import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createR2MultipartAccess } from "../scripts/lib/r2-multipart-upload.mjs";

const env = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "fake-access-key",
  R2_SECRET_ACCESS_KEY: "fake-secret",
  R2_BUCKET: "quadrics-test",
};
const partSize = 8 * 1024 * 1024;
const tenant = "10000000-0000-4000-8000-000000000001";
const gallery = "10000000-0000-4000-8000-000000000002";
const id = "10000000-0000-4000-8000-000000000003";
function reservation(overrides = {}) {
  return {
    storage_provider: "r2", tenant_id: tenant, gallery_id: gallery, id,
    object_path: `${tenant}/${gallery}/${id}.png`, byte_size: partSize + 128,
    content_type: "image/png", r2_multipart_upload_id: "fixture/upload+id",
    r2_multipart_started_at: new Date().toISOString(),
    state: "reserved", expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), ...overrides,
  };
}

function mockAccess(...responses) {
  const requests = [];
  const access = createR2MultipartAccess(env, {
    requestHandler: {
      async handle(request) {
        requests.push(request);
        const [statusCode, body = ""] = responses.shift();
        return { response: { statusCode, headers: { "content-type": "application/xml" }, body: Readable.from([Buffer.from(body)]) } };
      },
    },
  });
  return { access, requests };
}

function listedParts(lastSize = 128, truncated = false) {
  return `<ListPartsResult><IsTruncated>${truncated}</IsTruncated>
    <Part><PartNumber>1</PartNumber><ETag>"part-1"</ETag><Size>${partSize}</Size></Part>
    <Part><PartNumber>2</PartNumber><ETag>"part-2"</ETag><Size>${lastSize}</Size></Part>
  </ListPartsResult>`;
}

test("R2 multipart starts with the reservation ID in object metadata", async () => {
  const { access, requests } = mockAccess([200, "<InitiateMultipartUploadResult><UploadId>fixture/upload+id</UploadId></InitiateMultipartUploadResult>"]);
  assert.equal(await access.start(reservation({ r2_multipart_upload_id: null })), "fixture/upload+id");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers["x-amz-meta-write-id"], id);
  assert.equal(requests[0].headers["content-type"], "image/png");
  await assert.rejects(access.start(reservation()), { message: "R2_MULTIPART_ALREADY_STARTED" });
  await assert.rejects(access.start(reservation({ r2_multipart_upload_id: null, r2_multipart_started_at: null })),
    { message: "R2_MULTIPART_INTENT_REQUIRED" });
  await assert.rejects(access.start(reservation({ r2_multipart_upload_id: null, r2_put_authorized_at: new Date().toISOString() })),
    { message: "UPLOAD_PROVIDER_UNSUPPORTED" });
  assert.equal(requests.length, 1);
});

test("R2 multipart signs only in-range parts for the recorded upload ID and exact byte length", async () => {
  const { access, requests } = mockAccess();
  const signed = await access.signPart(reservation(), 2);
  const url = new URL(signed.url);
  assert.equal(url.searchParams.get("uploadId"), "fixture/upload+id");
  assert.equal(url.searchParams.get("partNumber"), "2");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
  assert.ok(url.searchParams.get("X-Amz-SignedHeaders").split(";").includes("content-length"));
  assert.equal(signed.byteSize, 128);
  await assert.rejects(access.signPart(reservation(), 3), { message: "R2_MULTIPART_PARTS_MISMATCH" });
  await assert.rejects(access.signPart(reservation({ r2_multipart_upload_id: null }), 1), { message: "R2_MULTIPART_ID_REQUIRED" });
  await assert.rejects(access.signPart(reservation({ state: "canceling" }), 1), { message: "UPLOAD_CLOSED" });
  assert.equal(requests.length, 0);
});

test("R2 multipart uses exactly the provider-listed parts and completes without overwriting an object", async () => {
  const { access, requests } = mockAccess(
    [200, listedParts()],
    [200, '<CompleteMultipartUploadResult><ETag>"result-2"</ETag></CompleteMultipartUploadResult>'],
  );
  assert.equal(await access.complete(reservation()), '"result-2"');
  assert.deepEqual(requests.map(request => request.method), ["GET", "POST"]);
  assert.equal(requests[1].headers["if-none-match"], "*");
  assert.match(String(requests[1].body), /<PartNumber>1<\/PartNumber>/);
  assert.match(String(requests[1].body), /<PartNumber>2<\/PartNumber>/);
});

test("R2 multipart does not commit incomplete, oversized or truncated part listings", async () => {
  for (const xml of [listedParts(129), listedParts(128, true), "<ListPartsResult />"]) {
    const { access, requests } = mockAccess([200, xml]);
    await assert.rejects(access.complete(reservation()), { message: "R2_MULTIPART_PARTS_MISMATCH" });
    assert.equal(requests.length, 1);
  }
});

test("multipart abort only proves closure with an explicit NoSuchUpload response", async () => {
  const closing = reservation({ state: "canceling" });
  const { access, requests } = mockAccess([204], [404, "<Error><Code>NoSuchUpload</Code></Error>"]);
  assert.equal(await access.abortAndCheckClosed(closing), true);
  assert.deepEqual(requests.map(request => request.method), ["DELETE", "GET"]);
  assert.equal(await mockAccess([204], [200, listedParts()]).access.abortAndCheckClosed(closing), false);
  await assert.rejects(mockAccess([204], [404, "<Error><Code>NoSuchBucket</Code></Error>"]).access.abortAndCheckClosed(closing),
    { message: "R2_MULTIPART_UNAVAILABLE" });
  await assert.rejects(mockAccess().access.abortAndCheckClosed(reservation()), { message: "UPLOAD_CANCELLATION_DENIED" });
});

test("ambiguous multipart completion stays unresolved", async () => {
  await assert.rejects(mockAccess([200, listedParts()], [503, "<Error><Code>ServiceUnavailable</Code></Error>"]).access.complete(reservation()),
    { message: "R2_MULTIPART_UNAVAILABLE" });
});
