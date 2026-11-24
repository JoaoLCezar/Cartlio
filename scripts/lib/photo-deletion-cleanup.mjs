import { createR2OriginalAccess } from "./r2-originals.mjs";

const r2MaximumReservationMs = 4 * 60 * 60 * 1000;
export const r2UploadCapabilitySettleMs = 5 * 60 * 1000;
export const r2DeletionAbsenceConfirmMs = 5 * 60 * 1000;

export function r2PhotoDeletionSafeAfter(photo, session) {
  const createdAt = Date.parse(photo?.created_at);
  if (!Number.isFinite(createdAt)) return null;
  const fallbackExpiry = createdAt + r2MaximumReservationMs;
  const sessionExpiry = session ? Date.parse(session.expires_at) : fallbackExpiry;
  if (!Number.isFinite(sessionExpiry)) return null;
  return Math.max(fallbackExpiry, sessionExpiry) + r2UploadCapabilitySettleMs;
}

async function removeSupabaseObject(client, bucket, path) {
  const result = await client.storage.from(bucket).remove([path]);
  if (result.error) throw new Error("Storage cleanup failed.");
}

async function recordR2ObjectAbsence(client, photo, absent) {
  const result = await client.rpc("record_r2_photo_deletion_absence", {
    p_tenant_id: photo.tenant_id,
    p_gallery_id: photo.gallery_id,
    p_photo_id: photo.id,
    p_object_absent: absent,
  });
  if (result.error || result.data !== true) throw new Error("R2 deletion state update failed.");
}

export async function cleanupPendingPhotoDeletions(client, photos, {
  r2Access: suppliedR2Access,
  uploadSessions = [],
  now = Date.now(),
} = {}) {
  const counts = { examined: photos.length, deleted: 0, deferred: 0, failed: 0 };
  const sessionsById = new Map(uploadSessions.map(session => [`${session.tenant_id ?? ""}/${session.id}`, session]));
  let r2Access = suppliedR2Access;

  for (const photo of photos) {
    const provider = photo.storage_provider ?? "supabase";
    if (!new Set(["supabase", "r2"]).has(provider)) {
      counts.failed += 1;
      continue;
    }

    const derivedPath = `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`;
    try {
      await removeSupabaseObject(client, "gallery-thumbnails", derivedPath);
      await removeSupabaseObject(client, "gallery-previews", derivedPath);

      if (provider === "supabase") {
        await removeSupabaseObject(client, "gallery-originals", photo.object_path);
        const finished = await client.rpc("finish_photo_deletion_worker", {
          p_tenant_id: photo.tenant_id,
          p_gallery_id: photo.gallery_id,
          p_photo_id: photo.id,
        });
        if (finished.error || finished.data !== true) throw new Error("Deletion completion failed.");
        counts.deleted += 1;
        continue;
      }

      const session = sessionsById.get(`${photo.tenant_id}/${photo.id}`)
        ?? sessionsById.get(`/${photo.id}`);
      const safeAfter = r2PhotoDeletionSafeAfter(photo, session);
      if (!Number.isFinite(safeAfter)) throw new Error("R2 upload expiry is unavailable.");
      if (now < safeAfter) {
        counts.deferred += 1;
        continue;
      }

      r2Access ??= createR2OriginalAccess();
      let deletion;
      try {
        deletion = await r2Access.deleteVerifiedOriginal(photo);
      } catch (error) {
        await recordR2ObjectAbsence(client, photo, false);
        throw error;
      }

      if (deletion.wasPresent) await recordR2ObjectAbsence(client, photo, false);
      if (!deletion.absent) {
        await recordR2ObjectAbsence(client, photo, false);
        counts.failed += 1;
        continue;
      }

      await recordR2ObjectAbsence(client, photo, true);
      const priorAbsenceAt = Date.parse(photo.storage_delete_absent_at);
      if (!deletion.wasPresent && Number.isFinite(priorAbsenceAt)
        && now - priorAbsenceAt >= r2DeletionAbsenceConfirmMs) {
        const finished = await client.rpc("finish_r2_photo_deletion_worker", {
          p_tenant_id: photo.tenant_id,
          p_gallery_id: photo.gallery_id,
          p_photo_id: photo.id,
        });
        if (finished.error || finished.data !== true) throw new Error("R2 deletion completion failed.");
        counts.deleted += 1;
      } else {
        counts.deferred += 1;
      }
    } catch {
      counts.failed += 1; // Durable intent remains for another retry; credentials and object paths stay out of logs.
    }
  }
  return counts;
}
