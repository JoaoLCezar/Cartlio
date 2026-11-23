export async function cleanupPendingPhotoDeletions(client, photos) {
  const counts = { examined: photos.length, deleted: 0, failed: 0 };
  for (const photo of photos) {
    const path = `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`;
    try {
      for (const [bucket, objectPath] of [
        ["gallery-thumbnails", path],
        ["gallery-previews", path],
        ["gallery-originals", photo.object_path],
      ]) {
        const removed = await client.storage.from(bucket).remove([objectPath]);
        if (removed.error) throw new Error("Storage cleanup failed.");
      }
      const finished = await client.rpc("finish_photo_deletion_worker", {
        p_tenant_id: photo.tenant_id,
        p_gallery_id: photo.gallery_id,
        p_photo_id: photo.id,
      });
      if (finished.error || finished.data !== true) throw new Error("Deletion completion failed.");
      counts.deleted += 1;
    } catch {
      counts.failed += 1; // Durable intent remains for another retry; credentials and object paths stay out of logs.
    }
  }
  return counts;
}
