import { addAbortSignal, Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createR2StorageClient, isStrongR2Etag, r2OriginalIdentity } from "./r2-storage-client.mjs";

const uploadUrlMaxSeconds = 60;

// Use authorized rows from PostgreSQL. This module is for the server only.
export function createR2OriginalAccess(env = process.env, { requestHandler } = {}) {
  const { client, bucket } = createR2StorageClient(env, requestHandler);

  async function openVerifiedOriginal(photo, { signal: callerSignal, timeoutMs = 120_000 } = {}) {
    const { path, bytes, type } = r2OriginalIdentity(photo);
    const etag = photo.storage_etag;
    if (!isStrongR2Etag(etag)) throw new Error("UPLOAD_MISMATCH");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let result;
    try {
      result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path, IfMatch: etag }), {
        abortSignal: signal,
      });
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 412) throw new Error("R2_ORIGINAL_CHANGED");
      throw new Error("R2_ORIGINAL_UNAVAILABLE");
    }

    const { Body: body, ContentLength: contentLength, ContentType: contentType, ETag: returnedTag } = result;
    if (!body || typeof body[Symbol.asyncIterator] !== "function") throw new Error("R2_ORIGINAL_UNAVAILABLE");
    if (contentLength !== bytes || contentType !== type || returnedTag !== etag) {
      body.destroy();
      throw new Error("R2_ORIGINAL_CHANGED");
    }

    async function* checkedChunks() {
      let received = 0;
      try {
        for await (const chunk of addAbortSignal(signal, body)) {
          if (!(chunk instanceof Uint8Array) || received + chunk.length > bytes) throw new Error("R2_ORIGINAL_CHANGED");
          received += chunk.length;
          yield chunk;
        }
      } catch (error) {
        if (error.message === "R2_ORIGINAL_CHANGED") throw error;
        throw new Error("R2_ORIGINAL_UNAVAILABLE");
      }
      if (received !== bytes) throw new Error("R2_ORIGINAL_UNAVAILABLE");
    }

    const output = Readable.from(checkedChunks(), { objectMode: false });
    output.once("close", () => body.destroy());
    return output;
  }

  return {
    async signUpload(reservation) {
      const { path, bytes, type } = r2OriginalIdentity(reservation);
      const now = Date.now();
      const expiresIn = Math.min(uploadUrlMaxSeconds, Math.floor((Date.parse(reservation.expires_at) - now) / 1000));
      if (reservation.state !== "reserved" || !Number.isFinite(expiresIn) || expiresIn < 1) {
        throw new Error("UPLOAD_CLOSED");
      }
      if (typeof reservation.r2_put_authorized_at !== "string" || !Number.isFinite(Date.parse(reservation.r2_put_authorized_at))) {
        throw new Error("UPLOAD_CONFIRMATION_DENIED");
      }
      const url = await getSignedUrl(client, new PutObjectCommand({
        Bucket: bucket, Key: path, ContentType: type, ContentLength: bytes, IfNoneMatch: "*",
      }), {
        signingDate: new Date(now),
        expiresIn,
        signableHeaders: new Set(["content-length", "content-type", "if-none-match"]),
      });
      // The browser sets Content-Length from the file body; it is part of the signature.
      return { url, method: "PUT", headers: { "Content-Type": type, "If-None-Match": "*" } };
    },

    openVerifiedOriginal,

    async readVerifiedOriginal(photo) {
      const body = await openVerifiedOriginal(photo, { timeoutMs: 30_000 });
      const data = Buffer.alloc(photo.byte_size);
      let offset = 0;
      for await (const chunk of body) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      return data;
    },
  };
}
