import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { auditRestoredPhotoStorage, countRowsInCopyDumps, isolatedSupabaseConfig, localizeRestoredR2Photos, parseRestoreCheckArguments, prepareRoleDump, restoreStorage, rowCountDifferences } from "../scripts/restore-check-local.mjs";

test("restore check requires a backup and only accepts explicit dry run", () => {
  assert.throws(() => parseRestoreCheckArguments([]), /--backup/);
  assert.deepEqual(parseRestoreCheckArguments(["--backup", "backup-dir", "--dry-run"]), {
    backup: resolve("backup-dir"),
    dryRun: true,
    e2e: false,
  });
  assert.deepEqual(parseRestoreCheckArguments(["--backup", "backup-dir", "--e2e"]), {
    backup: resolve("backup-dir"),
    dryRun: false,
    e2e: true,
  });
  assert.throws(() => parseRestoreCheckArguments(["--backup", "backup-dir", "--dry-run", "--e2e"]), /--dry-run/);
  assert.throws(() => parseRestoreCheckArguments(["backup-dir"]), /Uso:/);
  assert.throws(() => parseRestoreCheckArguments(["--backup", "backup-dir", "--remote"]), /Uso:/);
});

test("temporary Supabase config has isolated ports and keeps Cartlio bucket policies", () => {
  const source = [
    'project_id = "cartlio"',
    "[api]",
    "port = 54321",
    "[db]",
    "port = 54322",
    "shadow_port = 54320",
    "[local_smtp]",
    "enabled = true",
    "[storage.buckets.gallery-originals]",
    "public = false",
    'allowed_mime_types = ["image/jpeg", "image/png"]',
  ].join("\n");
  const config = isolatedSupabaseConfig(source, "cartlio-restore-test", {
    api: 55421, db: 55422, shadow: 55420, mail: 55424, smtp: 55425, pop3: 55426,
  });
  assert.match(config, /project_id = "cartlio-restore-test"/);
  assert.match(config, /port = 55421/);
  assert.match(config, /port = 55422/);
  assert.match(config, /shadow_port = 55420/);
  assert.match(config, /port = 55424/);
  assert.match(config, /smtp_port = 55425/);
  assert.match(config, /pop3_port = 55426/);
  assert.match(config, /public = false/);
  assert.match(config, /enabled = false/);
});

test("role restore keeps role settings and skips only Supabase-managed parameter ACL", () => {
  const sql = [
    'ALTER ROLE "anon" SET "statement_timeout" TO \'3s\';',
    'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
    "RESET ALL;",
  ].join("\n");
  const restored = prepareRoleDump(sql);
  assert.match(restored, /ALTER ROLE "anon"/);
  assert.match(restored, /RESET ALL/);
  assert.doesNotMatch(restored, /GRANT SET ON PARAMETER/);
});

test("database row counter reads COPY blocks across schemas without exposing row contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-restore-copy-count-"));
  try {
    await writeFile(join(directory, "auth-data.sql"), [
      'COPY "auth"."users" (id, email) FROM stdin;',
      "0001\\tfixture@example.test",
      "0002\\tsecond@example.test",
      "\\.",
    ].join("\n"));
    await writeFile(join(directory, "data.sql"), [
      "COPY public.galleries (id, name) FROM stdin;",
      "\\.",
      "COPY public.photos (id, name) FROM stdin;",
      "0001\\tfixture.jpg",
      "\\.",
    ].join("\n"));
    assert.deepEqual(await countRowsInCopyDumps(directory, ["auth-data.sql", "data.sql"]), [
      { schema: "auth", table: "users", rows: 2 },
      { schema: "public", table: "galleries", rows: 0 },
      { schema: "public", table: "photos", rows: 1 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("database row counter rejects truncated COPY data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-restore-truncated-copy-"));
  try {
    await writeFile(join(directory, "data.sql"), "COPY public.photos (id) FROM stdin;\n0001\n");
    await assert.rejects(countRowsInCopyDumps(directory, ["data.sql"]), /bloco COPY incompleto/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("row count comparison reports only table names and numeric totals", () => {
  assert.deepEqual(rowCountDifferences(
    [{ schema: "public", table: "photos", rows: 4 }, { schema: "auth", table: "users", rows: 2 }],
    [{ table: "public.photos", rows: 3 }, { table: "auth.users", rows: 2 }],
  ), [{ table: "public.photos", expected: 4, actual: 3 }]);
});

test("restored photo audit matches active originals and ready derivatives without retaining deleted photos", () => {
  const ready = {
    id: "photo-ready",
    tenant_id: "tenant-a",
    gallery_id: "gallery-a",
    object_path: "tenant-a/gallery-a/photo-ready.png",
    processing_status: "ready",
    deletion_requested_at: null,
  };
  const pending = {
    id: "photo-pending",
    tenant_id: "tenant-a",
    gallery_id: "gallery-a",
    object_path: "tenant-a/gallery-a/photo-pending.png",
    processing_status: "pending",
    deletion_requested_at: null,
  };
  const deleting = {
    id: "photo-deleting",
    tenant_id: "tenant-a",
    gallery_id: "gallery-a",
    object_path: "tenant-a/gallery-a/photo-deleting.png",
    processing_status: "ready",
    deletion_requested_at: "2026-10-23T00:00:00.000Z",
  };
  const derivative = "tenant-a/gallery-a/photo-ready.webp";
  const audit = auditRestoredPhotoStorage([ready, pending, deleting], {
    "gallery-originals": [{ path: ready.object_path }, { path: pending.object_path }],
    "gallery-previews": [{ path: derivative }],
    "gallery-thumbnails": [{ path: derivative }],
  });

  assert.equal(audit.active_photos, 2);
  assert.equal(audit.ready_photos, 1);
  assert.equal(audit.missing_originals, 0);
  assert.equal(audit.missing_derivatives, 0);
  assert.equal(audit.samples_by_tenant.get("tenant-a").readyPhoto.id, "photo-ready");
  const logoPath = "tenant-a/88888888-8888-4888-8888-888888888888.webp";
  const logoAudit = auditRestoredPhotoStorage([], {
    "gallery-brand-assets": [{ path: logoPath }],
  }, [{ id: "tenant-a", brand_logo_path: logoPath }]);
  assert.equal(logoAudit.brand_logos_examined, 1);
  assert.equal(logoAudit.missing_brand_assets, 0);
  const missingLogoAudit = auditRestoredPhotoStorage([], {
    "gallery-brand-assets": [],
  }, [{ id: "tenant-a", brand_logo_path: logoPath }]);
  assert.equal(missingLogoAudit.missing_brand_assets, 1);

  const broken = auditRestoredPhotoStorage([ready], {
    "gallery-originals": [],
    "gallery-previews": [{ path: derivative }],
    "gallery-thumbnails": [],
  });
  assert.equal(broken.missing_originals, 1);
  assert.equal(broken.missing_derivatives, 1);
});

test("restored photo audit recognizes R2 originals copied into the temporary Supabase bucket", () => {
  const photo = {
    id: "photo-r2",
    tenant_id: "tenant-r2",
    gallery_id: "gallery-r2",
    object_path: "tenant-r2/gallery-r2/photo-r2.png",
    storage_provider: "supabase",
    processing_status: "pending",
    deletion_requested_at: null,
  };
  const audit = auditRestoredPhotoStorage([photo], {
    "gallery-originals": [],
    "gallery-previews": [],
    "gallery-thumbnails": [],
    "gallery-brand-assets": [],
  }, [], [{ path: photo.object_path, bytes: 4, content_type: "image/png", etag: '"photo-etag"' }]);

  assert.equal(audit.missing_originals, 0);
});

test("restore check copies archived R2 originals into Supabase and verifies their hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-restore-r2-storage-"));
  const objectPath = "10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/10000000-0000-4000-8000-000000000003.png";
  const bytes = Buffer.from([1, 2, 3, 4]);
  const restored = new Map();
  try {
    await mkdir(join(directory, "storage", "r2-originals", ...objectPath.split("/").slice(0, 2)), { recursive: true });
    await writeFile(join(directory, "storage", "r2-originals", ...objectPath.split("/")), bytes);
    const manifest = {
      format_version: 5,
      storage_files: {
        "gallery-originals": [],
        "gallery-previews": [],
        "gallery-thumbnails": [],
        "gallery-brand-assets": [],
      },
      r2_storage_files: [{ path: objectPath, bytes: bytes.length, content_type: "image/png", etag: '"photo-etag"' }],
      files: [{ path: `storage/r2-originals/${objectPath}`, sha256: createHash("sha256").update(bytes).digest("hex") }],
    };
    const client = { storage: { from(bucket) { return {
      async upload(path, value, options) {
        assert.equal(bucket, "gallery-originals");
        restored.set(path, { bytes: Buffer.from(value), options });
        return { error: null };
      },
      async download(path) {
        const item = restored.get(path);
        return { data: item ? new Blob([item.bytes]) : null, error: item ? null : new Error("missing") };
      },
    }; } } };

    await restoreStorage(client, directory, manifest);
    assert.deepEqual(restored.get(objectPath).bytes, bytes);
    assert.equal(restored.get(objectPath).options.contentType, "image/png");
    assert.equal(restored.get(objectPath).options.upsert, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("restore check localizes R2 photo rows only after backup metadata matches", async () => {
  const photo = {
    id: "10000000-0000-4000-8000-000000000003",
    tenant_id: "10000000-0000-4000-8000-000000000001",
    gallery_id: "10000000-0000-4000-8000-000000000002",
    object_path: "10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/10000000-0000-4000-8000-000000000003.png",
    storage_provider: "r2",
    content_type: "image/png",
    byte_size: 4,
    storage_etag: '"photo-etag"',
  };
  const r2Files = [{ path: photo.object_path, bytes: 4, content_type: "image/png", etag: photo.storage_etag }];
  const updated = [];
  let photoRows = [photo];
  let activeSessionCount = 0;
  const client = { from(table) {
    let mode = "read";
    return {
      select(_columns, options) { if (options?.head) mode = "count"; return this; },
      eq(column, value) { assert.equal(column, "storage_provider"); assert.equal(value, "r2"); return this; },
      in(column, values) { assert.equal(column, "state"); assert.deepEqual(values, ["reserved", "canceling"]); return this; },
      order() { return this; },
      range() { return Promise.resolve({ data: table === "photos" ? photoRows : [], error: null }); },
      update(values) { mode = "update"; updated.push({ table, values }); return this; },
      then(resolve, reject) {
        const result = mode === "count" ? { count: activeSessionCount, error: null }
          : { data: mode === "update" && table === "photos" ? photoRows : [], error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  } };

  assert.equal(await localizeRestoredR2Photos(client, r2Files), 1);
  assert.deepEqual(updated, [
    { table: "photos", values: { storage_provider: "supabase", storage_etag: null, storage_delete_absent_at: null } },
    { table: "upload_sessions", values: {
      storage_provider: "supabase",
      r2_put_authorized_at: null,
      r2_multipart_state: null,
      r2_multipart_upload_id: null,
      r2_multipart_started_at: null,
      r2_multipart_claimed_at: null,
    } },
  ]);

  updated.length = 0;
  await assert.rejects(localizeRestoredR2Photos(client, [{ ...r2Files[0], etag: '"wrong-etag"' }]), /inventário R2/i);
  assert.deepEqual(updated, []);

  activeSessionCount = 1;
  await assert.rejects(localizeRestoredR2Photos(client, r2Files), /envios R2 ativos/i);
  assert.deepEqual(updated, []);

  activeSessionCount = 0;
  photoRows = [];
  assert.equal(await localizeRestoredR2Photos(client, []), 0);
  assert.deepEqual(updated, [{ table: "upload_sessions", values: {
    storage_provider: "supabase",
    r2_put_authorized_at: null,
    r2_multipart_state: null,
    r2_multipart_upload_id: null,
    r2_multipart_started_at: null,
    r2_multipart_claimed_at: null,
  } }]);

  updated.length = 0;
  photoRows = [{ ...photo, deletion_requested_at: "2026-11-20T10:00:00.000Z" }];
  assert.equal(await localizeRestoredR2Photos(client, []), 1);
  assert.equal(updated[0].table, "photos");
  assert.equal(updated[0].values.storage_delete_absent_at, null);
});
