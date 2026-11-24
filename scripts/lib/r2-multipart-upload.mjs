import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, ListPartsCommand, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createR2StorageClient, isStrongR2Etag, r2OriginalIdentity } from "./r2-storage-client.mjs";

const partBytes = 8 * 1024 * 1024;
const urlMaxSeconds = 60;

function activeUploadWindow(reservation) {
  const now = Date.now();
  const expiresIn = Math.min(urlMaxSeconds, Math.floor((Date.parse(reservation.expires_at) - now) / 1000));
  if (reservation.state !== "reserved" || !Number.isFinite(expiresIn) || expiresIn < 1) {
    throw new Error("UPLOAD_CLOSED");
  }
  if (reservation.r2_put_authorized_at != null) throw new Error("UPLOAD_PROVIDER_UNSUPPORTED");
  if (typeof reservation.r2_multipart_started_at !== "string" || !Number.isFinite(Date.parse(reservation.r2_multipart_started_at))) {
    throw new Error("R2_MULTIPART_INTENT_REQUIRED");
  }
  return { signingDate: new Date(now), expiresIn };
}

function validUploadId(value) {
  return typeof value === "string" && /^[!-~]{1,1024}$/.test(value);
}

function isClosedUpload(error) {
  return error?.name === "NoSuchUpload" && error.$metadata?.httpStatusCode === 404;
}

function handleStorageFailure(error) {
  if (isClosedUpload(error)) throw new Error("R2_MULTIPART_CLOSED");
  if (error?.$metadata?.httpStatusCode === 412) throw new Error("R2_MULTIPART_DESTINATION_EXISTS");
  throw new Error("R2_MULTIPART_UNAVAILABLE");
}

function expectedParts(bytes) {
  return Array.from({ length: Math.ceil(bytes / partBytes) }, (_, index) => Math.min(partBytes, bytes - index * partBytes));
}

function completeParts(response, sizes) {
  if (response.IsTruncated || response.Parts?.length !== sizes.length) throw new Error("R2_MULTIPART_PARTS_MISMATCH");
  const ordered = [...response.Parts].sort((left, right) => left.PartNumber - right.PartNumber);
  return ordered.map((part, index) => {
    if (part.PartNumber !== index + 1 || part.Size !== sizes[index] || !isStrongR2Etag(part.ETag)) {
      throw new Error("R2_MULTIPART_PARTS_MISMATCH");
    }
    return { PartNumber: part.PartNumber, ETag: part.ETag };
  });
}

// Server only. The caller must persist an initiation intent before start()
// and store the returned UploadId before issuing any part URL.
export function createR2MultipartAccess(env = process.env, { requestHandler } = {}) {
  const { client, bucket } = createR2StorageClient(env, requestHandler);
  const send = (command, timeoutMs = 10_000) => client.send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });

  function locator(reservation) {
    const { path, bytes } = r2OriginalIdentity(reservation);
    if (!validUploadId(reservation.r2_multipart_upload_id)) throw new Error("R2_MULTIPART_ID_REQUIRED");
    return {
      target: { Bucket: bucket, Key: path, UploadId: reservation.r2_multipart_upload_id },
      sizes: expectedParts(bytes),
    };
  }

  return {
    async start(reservation) {
      const { path, type } = r2OriginalIdentity(reservation);
      activeUploadWindow(reservation);
      if (reservation.r2_multipart_upload_id != null) throw new Error("R2_MULTIPART_ALREADY_STARTED");
      let response;
      try {
        response = await send(new CreateMultipartUploadCommand({
          Bucket: bucket, Key: path, ContentType: type, Metadata: { "write-id": reservation.id },
        }));
      } catch (error) {
        handleStorageFailure(error);
      }
      if (!validUploadId(response.UploadId)) throw new Error("R2_MULTIPART_UNAVAILABLE");
      return response.UploadId;
    },

    async signPart(reservation, partNumber) {
      const { target, sizes } = locator(reservation);
      const window = activeUploadWindow(reservation);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > sizes.length) {
        throw new Error("R2_MULTIPART_PARTS_MISMATCH");
      }
      const byteSize = sizes[partNumber - 1];
      const url = await getSignedUrl(client, new UploadPartCommand({
        ...target, PartNumber: partNumber, ContentLength: byteSize,
      }), { ...window, signableHeaders: new Set(["content-length"]) });
      return { url, method: "PUT", partNumber, byteSize };
    },

    async complete(reservation) {
      const { target, sizes } = locator(reservation);
      activeUploadWindow(reservation);
      let listed;
      try {
        listed = await send(new ListPartsCommand({ ...target, MaxParts: sizes.length + 1 }));
      } catch (error) {
        handleStorageFailure(error);
      }
      const parts = completeParts(listed, sizes);
      activeUploadWindow(reservation);
      let response;
      try {
        response = await send(new CompleteMultipartUploadCommand({
          ...target, IfNoneMatch: "*", MultipartUpload: { Parts: parts },
        }), 30_000);
      } catch (error) {
        handleStorageFailure(error);
      }
      if (!isStrongR2Etag(response.ETag)) throw new Error("R2_MULTIPART_UNAVAILABLE");
      return response.ETag;
    },

    async abortAndCheckClosed(reservation) {
      const { target } = locator(reservation);
      if (reservation.state !== "canceling" || reservation.r2_put_authorized_at != null) {
        throw new Error("UPLOAD_CANCELLATION_DENIED");
      }
      try {
        await send(new AbortMultipartUploadCommand(target));
      } catch (error) {
        if (!isClosedUpload(error)) throw new Error("R2_MULTIPART_UNAVAILABLE");
      }
      try {
        await send(new ListPartsCommand({ ...target, MaxParts: 1 }));
        return false;
      } catch (error) {
        if (isClosedUpload(error)) return true;
        throw new Error("R2_MULTIPART_UNAVAILABLE");
      }
    },
  };
}
