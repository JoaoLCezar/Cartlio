import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { auditRestoredPhotoStorage, countRowsInCopyDumps, isolatedSupabaseConfig, parseRestoreCheckArguments, prepareRoleDump, rowCountDifferences } from "../scripts/restore-check-local.mjs";

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
