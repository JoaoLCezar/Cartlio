import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertBackupOutsideProject, copyStorageBucket, copyWorkspaceMigrations, localDatabaseDumps, parseBackupArguments, verifyBackup, writeBackupManifest } from "../scripts/lib/backup.mjs";
import { encryptBackupDirectory, isSafeArchivePath, prepareBackupDirectory } from "../scripts/lib/backup-encryption.mjs";
import { runRestoreCheck } from "../scripts/restore-check-local.mjs";

async function createCompleteBackup(directory) {
  for (const dump of localDatabaseDumps) await writeFile(join(directory, dump.filename), `-- ${dump.filename}\n`);
  await writeFile(join(directory, "RESTORE.md"), "restore guide");
  await mkdir(join(directory, "migrations"), { recursive: true });
  await writeFile(join(directory, "migrations", "001_fixture.sql"), "select 1;");
  await mkdir(join(directory, "storage", "gallery-originals", "tenant"), { recursive: true });
  await writeFile(join(directory, "storage", "gallery-originals", "tenant", "photo.png"), "photo-bytes");
  const storageFiles = {
    "gallery-originals": [{ path: "tenant/photo.png", bytes: 11, content_type: "image/png", cache_control: "max-age=300" }],
    "gallery-previews": [],
    "gallery-thumbnails": [],
    "gallery-brand-assets": [],
  };
  const storageObjects = Object.fromEntries(Object.entries(storageFiles).map(([bucket, files]) => [bucket, files.length]));
  const storageObjectBytes = Object.fromEntries(Object.entries(storageFiles).map(([bucket, files]) => [bucket, files.reduce((total, file) => total + file.bytes, 0)]));
  return writeBackupManifest(directory, {
    database_files: localDatabaseDumps.map(dump => dump.filename),
    database_data_schemas: ["public"],
    migration_files: ["001_fixture.sql"],
    storage_objects: storageObjects,
    storage_object_bytes: storageObjectBytes,
    storage_files: storageFiles,
  });
}

test("backup arguments choose a private destination and reject unknown options", () => {
  const defaultOutput = join("private", "cartlio");
  const otherOutput = join("other", "backups");
  assert.deepEqual(parseBackupArguments(["--dry-run"], defaultOutput), { output: resolve(defaultOutput), dryRun: true, encrypt: false });
  assert.deepEqual(parseBackupArguments(["--output", otherOutput, "--encrypt"], defaultOutput), { output: resolve(otherOutput), dryRun: false, encrypt: true });
  assert.throws(() => parseBackupArguments(["--remote"], defaultOutput), /Uso:/);
  assert.throws(() => parseBackupArguments(["--output"], defaultOutput), /Uso:/);
});

test("local backup explicitly exports managed Auth user data before app data", () => {
  const authIndex = localDatabaseDumps.findIndex(dump => dump.filename === "auth-data.sql");
  const appDataIndex = localDatabaseDumps.findIndex(dump => dump.filename === "data.sql");
  assert.ok(authIndex >= 0 && authIndex < appDataIndex);
  assert.deepEqual(localDatabaseDumps[authIndex].args, ["db", "dump", "--local", "--schema", "auth", "--data-only", "--use-copy"]);
  assert.deepEqual(localDatabaseDumps[appDataIndex].args, ["db", "dump", "--local", "--data-only", "--use-copy", "--schema", "public"]);
  assert.ok(localDatabaseDumps.some(dump => dump.filename === "migration-history-data.sql"));
});

test("backup output cannot be placed inside the repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cartlio-backup-path-"));
  const project = join(parent, "project");
  const nested = join(project, "backups");
  try {
    await mkdir(nested, { recursive: true });
    assert.throws(() => assertBackupOutsideProject(project, project), /fora da pasta/);
    assert.throws(() => assertBackupOutsideProject(nested, project), /fora da pasta/);
    assert.equal(assertBackupOutsideProject(join(parent, "private-backups"), project), join(parent, "private-backups"));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("backup includes a sorted, byte-identical copy of workspace migrations", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cartlio-migrations-backup-"));
  const source = join(parent, "source");
  const destination = join(parent, "backup", "migrations");
  try {
    await mkdir(source);
    await writeFile(join(source, "002_second.sql"), "select 2;");
    await writeFile(join(source, "001_first.sql"), "select 1;");
    assert.deepEqual(await copyWorkspaceMigrations(source, destination, ["002_second.sql", "001_first.sql"]), ["001_first.sql", "002_second.sql"]);
    assert.equal(await readFile(join(destination, "001_first.sql"), "utf8"), "select 1;");
    await assert.rejects(copyWorkspaceMigrations(source, destination, ["../outside.sql"]), /Nome de migration inválido/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("storage backup walks folders and downloads each object without overwriting", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cartlio-storage-backup-"));
  const destination = join(parent, "gallery-originals");
  const paths = [];
  const storage = {
    from(bucket) {
      assert.equal(bucket, "gallery-originals");
      return {
        async list(prefix, options) {
          assert.equal(options.limit, 100);
          if (prefix === "") return { data: [{ name: "tenant", metadata: null }], error: null };
          if (prefix === "tenant") return { data: [{ name: "photo.png", metadata: { mimetype: "image/png", cacheControl: "max-age=300", size: 11 } }], error: null };
          return { data: [], error: null };
        },
        async download(path) { paths.push(path); return { data: new Blob(["photo-bytes"]), error: null }; },
      };
    },
  };
  try {
    const files = await copyStorageBucket(storage, "gallery-originals", destination);
    assert.deepEqual(paths, ["tenant/photo.png"]);
    assert.deepEqual(files, [{ path: "tenant/photo.png", bytes: 11, content_type: "image/png", cache_control: "max-age=300" }]);
    assert.equal(await readFile(join(destination, "tenant", "photo.png"), "utf8"), "photo-bytes");
    await assert.rejects(copyStorageBucket(storage, "gallery-originals", destination));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("backup manifest verifies file hashes and rejects changed or extra files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-backup-manifest-"));
  try {
    const manifest = await createCompleteBackup(directory);
    assert.equal(manifest.format_version, 4);
    const verified = await verifyBackup(directory);
    assert.deepEqual(verified, { valid: true, complete: true, format_version: 4, files: manifest.files.length, bytes: manifest.files.reduce((total, file) => total + file.size, 0) });
    await writeFile(join(directory, "unexpected.txt"), "untracked");
    await assert.rejects(verifyBackup(directory), /quantidade de arquivos/);
    await rm(join(directory, "unexpected.txt"));
    await writeFile(join(directory, "auth-data.sql"), "changed");
    await assert.rejects(verifyBackup(directory), /integridade falhou/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("format 3 backups keep their original three-bucket restore contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-backup-v3-"));
  try {
    const manifest = await createCompleteBackup(directory);
    manifest.format_version = 3;
    delete manifest.storage_files["gallery-brand-assets"];
    delete manifest.storage_objects["gallery-brand-assets"];
    delete manifest.storage_object_bytes["gallery-brand-assets"];
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(await verifyBackup(directory), {
      valid: true,
      complete: true,
      format_version: 3,
      files: manifest.files.length,
      bytes: manifest.files.reduce((total, file) => total + file.size, 0),
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new-format verification rejects an archive that omits Auth data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-incomplete-structure-"));
  try {
    const manifest = await createCompleteBackup(directory);
    manifest.database_files = manifest.database_files.filter(filename => filename !== "auth-data.sql");
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(verifyBackup(directory), /conjunto esperado de dumps/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new-format verification rejects Storage bytes without matching object metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-missing-storage-metadata-"));
  try {
    const manifest = await createCompleteBackup(directory);
    manifest.storage_files["gallery-originals"] = [];
    manifest.storage_objects["gallery-originals"] = 0;
    manifest.storage_object_bytes["gallery-originals"] = 0;
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(verifyBackup(directory), /Storage não correspondem ao manifesto/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy archives verify hashes but are clearly marked incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-legacy-backup-"));
  try {
    await writeFile(join(directory, "data.sql"), "legacy-data");
    const manifest = await writeBackupManifest(directory);
    manifest.format_version = 1;
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await verifyBackup(directory);
    assert.equal(result.valid, true);
    assert.equal(result.complete, false);
    assert.match(result.warnings[0], /não inclui a exportação explícita dos dados de Auth/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("format 2 archives are incomplete because app data may duplicate Auth and Storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-legacy-v2-backup-"));
  try {
    await writeFile(join(directory, "data.sql"), "legacy-data");
    const manifest = await writeBackupManifest(directory);
    manifest.format_version = 2;
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await verifyBackup(directory);
    assert.equal(result.valid, true);
    assert.equal(result.complete, false);
    assert.match(result.warnings[0], /pode duplicar Auth e Storage/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("backup verification rejects a snapshot that still has its incomplete marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartlio-incomplete-backup-"));
  try {
    await writeFile(join(directory, "INCOMPLETE"), "still running");
    await createCompleteBackup(directory);
    await assert.rejects(verifyBackup(directory), /Backup incompleto/);
    await rm(join(directory, "INCOMPLETE"));
    assert.equal((await verifyBackup(directory)).complete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("encrypted backup hides filenames and contents, then restores a complete verifiable snapshot", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cartlio-backup-encrypted-"));
  const source = join(parent, "source");
  const archive = join(parent, "cartlio-fixture.cartlio.enc");
  const passphrase = "fixture phrase with enough entropy";
  try {
    await mkdir(source);
    const manifest = await createCompleteBackup(source);
    const encrypted = await encryptBackupDirectory(source, archive, passphrase);
    assert.equal(encrypted.files, manifest.files.length + 1);
    const archiveBytes = await readFile(archive);
    await assert.rejects(encryptBackupDirectory(source, archive, passphrase), /already exists/i);
    assert.deepEqual(await readFile(archive), archiveBytes);
    assert.equal(archiveBytes.includes(Buffer.from("auth-data.sql")), false);
    assert.equal(archiveBytes.includes(Buffer.from("manifest.json")), false);
    assert.equal(archiveBytes.includes(Buffer.from("photo-bytes")), false);

    const prepared = await prepareBackupDirectory(archive, passphrase);
    try {
      assert.equal(prepared.encrypted, true);
      assert.equal((await verifyBackup(prepared.path)).complete, true);
      assert.equal(await readFile(join(prepared.path, "storage", "gallery-originals", "tenant", "photo.png"), "utf8"), "photo-bytes");
    } finally {
      await prepared.cleanup();
    }
    const previousPassphrase = process.env.CARTLIO_BACKUP_PASSPHRASE;
    process.env.CARTLIO_BACKUP_PASSPHRASE = passphrase;
    try {
      const restorePlan = await runRestoreCheck(["--backup", archive, "--dry-run"]);
      assert.equal(restorePlan.valid, true);
      assert.equal(restorePlan.dry_run, true);
      assert.equal(restorePlan.backup_encrypted, true);
    } finally {
      if (previousPassphrase === undefined) delete process.env.CARTLIO_BACKUP_PASSPHRASE;
      else process.env.CARTLIO_BACKUP_PASSPHRASE = previousPassphrase;
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("encrypted backup rejects wrong passphrases, tampering, and unsafe cross-platform paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cartlio-backup-encrypted-invalid-"));
  const source = join(parent, "source");
  const archive = join(parent, "valid.cartlio.enc");
  const tampered = join(parent, "tampered.cartlio.enc");
  try {
    await mkdir(source);
    await createCompleteBackup(source);
    await encryptBackupDirectory(source, archive, "valid fixture passphrase 123");
    await assert.rejects(prepareBackupDirectory(archive, "incorrect fixture passphrase"), /authentication failed/i);

    const bytes = await readFile(archive);
    bytes[bytes.length - 5] ^= 1;
    await writeFile(tampered, bytes);
    await assert.rejects(prepareBackupDirectory(tampered, "valid fixture passphrase 123"), /authentication failed|invalid end marker/i);
    assert.equal(isSafeArchivePath("tenant/photo.png"), true);
    assert.equal(isSafeArchivePath("../outside.txt"), false);
    assert.equal(isSafeArchivePath("C:/outside.txt"), false);
    assert.equal(isSafeArchivePath("tenant\\photo.png"), false);
    assert.equal(isSafeArchivePath("tenant/NUL.txt"), false);
    assert.equal(isSafeArchivePath("tenant/photo. "), false);
    assert.equal(isSafeArchivePath("tenant/photo:stream"), false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
