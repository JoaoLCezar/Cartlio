import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isStrongR2Etag, r2OriginalIdentity } from "./r2-storage-client.mjs";

export const legacyBackupBuckets = ["gallery-originals", "gallery-previews", "gallery-thumbnails"];
export const backupBuckets = [...legacyBackupBuckets, "gallery-brand-assets"];

export function backupBucketsForManifest(manifest) {
  return manifest?.format_version >= 4 ? backupBuckets : legacyBackupBuckets;
}

export function assertR2BackupInventory(photos, objects) {
  if (!Array.isArray(photos) || !(objects instanceof Map)) throw new Error("O inventário R2 não corresponde às referências do banco.");
  const expected = new Map();
  try {
    for (const photo of photos) {
      const identity = r2OriginalIdentity(photo);
      if (!isStrongR2Etag(photo.storage_etag) || expected.has(identity.path)) {
        throw new Error("invalid photo identity");
      }
      if (!objects.has(identity.path) && photo.deletion_requested_at != null) continue;
      expected.set(identity.path, photo);
    }
  } catch {
    throw new Error("O inventário R2 não corresponde às referências do banco.");
  }
  if (expected.size !== objects.size) throw new Error("O inventário R2 não corresponde às referências do banco.");
  for (const [path, photo] of expected) {
    const object = objects.get(path);
    if (!object || object.size !== photo.byte_size || object.etag !== photo.storage_etag) {
      throw new Error("O inventário R2 não corresponde às referências do banco.");
    }
  }
  return [...expected.values()].sort((left, right) => left.object_path.localeCompare(right.object_path));
}

export async function copyR2Originals(photos, objects, destination, readOriginal) {
  if (typeof readOriginal !== "function") throw new Error("A leitura verificada dos originais R2 não está disponível.");
  const orderedPhotos = assertR2BackupInventory(photos, objects);
  const root = resolve(destination);
  const files = [];
  for (const photo of orderedPhotos) {
    const { path, bytes: expectedBytes, type } = r2OriginalIdentity(photo);
    const outputFile = resolve(root, ...path.split("/"));
    const withinBucket = relative(root, outputFile);
    if (!withinBucket || withinBucket === ".." || withinBucket.startsWith(`..${sep}`) || isAbsolute(withinBucket)) {
      throw new Error("O inventário R2 contém um caminho fora do diretório de backup.");
    }
    const original = await readOriginal(photo);
    if (!(original instanceof Uint8Array) || original.byteLength !== expectedBytes) {
      throw new Error("A leitura do original R2 não corresponde à reserva registrada.");
    }
    await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
    await writeFile(outputFile, Buffer.from(original), { flag: "wx", mode: 0o600 });
    files.push({ path, bytes: expectedBytes, content_type: type, etag: photo.storage_etag });
  }
  return files;
}

export async function assertBackupStorageComplete(client) {
  const [photos, sessions] = await Promise.all([
    client.from("photos").select("id", { count: "exact", head: true }).eq("storage_provider", "r2"),
    client.from("upload_sessions").select("id", { count: "exact", head: true })
      .eq("storage_provider", "r2").in("state", ["reserved", "canceling"]),
  ]);
  if (photos.error || sessions.error || !Number.isSafeInteger(photos.count) || !Number.isSafeInteger(sessions.count)) {
    throw new Error("Não foi possível confirmar a integridade do armazenamento antes do backup.");
  }
  if (sessions.count > 0) throw new Error("Aguarde o fim dos envios R2 ativos antes de iniciar o backup.");
  return { r2_photos: photos.count, r2_active_upload_sessions: sessions.count };
}

export const localDatabaseDumps = [
  { filename: "roles.sql", args: ["db", "dump", "--local", "--role-only"] },
  { filename: "schema.sql", args: ["db", "dump", "--local"] },
  { filename: "auth-data.sql", args: ["db", "dump", "--local", "--schema", "auth", "--data-only", "--use-copy"] },
  { filename: "data.sql", args: ["db", "dump", "--local", "--data-only", "--use-copy", "--schema", "public"] },
  { filename: "migration-history-schema.sql", args: ["db", "dump", "--local", "--schema", "supabase_migrations"] },
  { filename: "migration-history-data.sql", args: ["db", "dump", "--local", "--schema", "supabase_migrations", "--data-only", "--use-copy"] },
];

export function parseBackupArguments(argv, defaultOutput) {
  const options = { output: resolve(defaultOutput), dryRun: false, encrypt: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output" && argv[index + 1]) options.output = resolve(argv[++index]);
    else if (argument === "--dry-run" && !options.dryRun) options.dryRun = true;
    else if (argument === "--encrypt" && !options.encrypt) options.encrypt = true;
    else throw new Error("Uso: npm run backup:local -- [--output DIRETÓRIO] [--dry-run] [--encrypt]");
  }
  return options;
}

export function assertBackupOutsideProject(outputPath, projectRoot) {
  const destination = resolve(outputPath);
  const root = resolve(projectRoot);
  const relativePath = relative(root, destination);
  const isInsideProject = !relativePath || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  if (isInsideProject) {
    throw new Error("O backup precisa ficar fora da pasta do projeto.");
  }
  return destination;
}

export async function copyWorkspaceMigrations(sourceDirectory, destination, filenames) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const filename of [...filenames].sort()) {
    if (basename(filename) !== filename || !filename.endsWith(".sql")) {
      throw new Error("Nome de migration inválido.");
    }
    const contents = await readFile(join(sourceDirectory, filename));
    if (contents.length === 0) throw new Error(`A migration ${filename} está vazia.`);
    await writeFile(join(destination, filename), contents, { flag: "wx", mode: 0o600 });
    copied.push(filename);
  }
  return copied;
}

export async function copyStorageBucket(storage, bucket, destination) {
  const bucketStorage = storage.from(bucket);
  const files = [];
  const pendingFolders = [""];
  while (pendingFolders.length) {
    const prefix = pendingFolders.pop();
    for (let offset = 0; ; offset += 100) {
      const { data: items, error: listError } = await bucketStorage.list(prefix, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (listError) throw new Error(`Falha ao listar o bucket ${bucket}: ${listError.message}`);
      if (!items?.length) break;
      for (const item of items) {
        if (!item.name || item.name === "." || item.name === ".." || item.name.includes("/") || item.name.includes("\\")) {
          throw new Error(`O bucket ${bucket} contém um caminho inválido.`);
        }
        const objectPath = prefix ? `${prefix}/${item.name}` : item.name;
        if (!item.metadata) {
          pendingFolders.push(objectPath);
          continue;
        }
        const { data, error: downloadError } = await bucketStorage.download(objectPath);
        if (downloadError || !data) throw new Error(`Falha ao baixar ${bucket}/${objectPath}: ${downloadError?.message ?? "arquivo vazio"}`);
        const outputFile = resolve(destination, ...objectPath.split("/"));
        const withinBucket = relative(destination, outputFile);
        if (!withinBucket || withinBucket === ".." || withinBucket.startsWith(`..${sep}`) || isAbsolute(withinBucket)) {
          throw new Error(`O bucket ${bucket} contém um caminho fora do diretório de backup.`);
        }
        await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
        const bytes = Buffer.from(await data.arrayBuffer());
        if (Number.isInteger(item.metadata.size) && item.metadata.size !== bytes.length) {
          throw new Error(`O tamanho baixado não corresponde ao Storage: ${bucket}/${objectPath}`);
        }
        await writeFile(outputFile, bytes, { flag: "wx", mode: 0o600 });
        files.push({
          path: objectPath,
          bytes: bytes.length,
          content_type: item.metadata.mimetype ?? null,
          cache_control: item.metadata.cacheControl ?? null,
        });
      }
      if (items.length < 100) break;
    }
  }
  return files;
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("O backup não pode conter links simbólicos.");
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, fullPath));
    else if (entry.isFile() && !["manifest.json", "INCOMPLETE"].includes(relative(root, fullPath))) files.push(fullPath);
    else if (!entry.isFile()) throw new Error("O backup contém um tipo de arquivo não suportado.");
  }
  return files;
}

export async function writeBackupManifest(root, details = {}) {
  const files = await listFiles(root);
  const entries = [];
  for (const fullPath of files.sort()) {
    const bytes = await readFile(fullPath);
    entries.push({
      path: relative(root, fullPath).split(sep).join("/"),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const r2StorageFiles = details.r2_storage_files ?? [];
  const manifest = {
    created_at: new Date().toISOString(),
    consistency_note: "Pause every process that can write to the database or Storage before starting; the SQL and Storage copies are sequential, not one atomic snapshot.",
    ...details,
    format_version: 5,
    r2_storage_files: r2StorageFiles,
    r2_storage_objects: details.r2_storage_objects ?? r2StorageFiles.length,
    r2_storage_object_bytes: details.r2_storage_object_bytes ?? r2StorageFiles.reduce((total, file) => total + file.bytes, 0),
    files: entries,
  };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

export async function verifyBackup(rootPath) {
  const root = resolve(rootPath);
  try {
    await lstat(join(root, "INCOMPLETE"));
    throw new Error("Backup incompleto: não restaure esse diretório.");
  } catch (error) {
    if (error instanceof Error && error.message === "Backup incompleto: não restaure esse diretório.") throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const manifestPath = join(root, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("Manifesto de backup inválido.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (![1, 2, 3, 4, 5].includes(manifest.format_version) || !Array.isArray(manifest.files)) throw new Error("Formato de backup não reconhecido.");
  const expected = new Map();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !file.path || isAbsolute(file.path) || file.path.includes("\\") || file.path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
      throw new Error("Manifesto contém um caminho inválido.");
    }
    if (expected.has(file.path)) throw new Error("Manifesto contém caminhos repetidos.");
    expected.set(file.path, file);
  }
  const actual = await listFiles(root);
  if (actual.length !== expected.size) throw new Error("A quantidade de arquivos não corresponde ao manifesto.");
  for (const fullPath of actual) {
    const path = relative(root, fullPath).split(sep).join("/");
    const expectedFile = expected.get(path);
    if (!expectedFile) throw new Error(`Arquivo não registrado no manifesto: ${path}`);
    const bytes = await readFile(fullPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expectedFile.size || sha256 !== expectedFile.sha256) throw new Error(`Verificação de integridade falhou: ${path}`);
  }
  const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
  if (manifest.format_version < 3) {
    return {
      valid: true,
      complete: false,
      format_version: manifest.format_version,
      warnings: [manifest.format_version === 1
        ? "Backup legado: não inclui a exportação explícita dos dados de Auth nem as migrations copiadas para recuperação."
        : "Backup formato 2: o dump geral não restringia dados ao schema da aplicação e pode duplicar Auth e Storage durante uma restauração."],
      files: actual.length,
      bytes,
    };
  }

  const paths = new Set(actual.map(fullPath => relative(root, fullPath).split(sep).join("/")));
  const expectedDatabaseFiles = localDatabaseDumps.map(dump => dump.filename);
  if (JSON.stringify(manifest.database_files) !== JSON.stringify(expectedDatabaseFiles)) {
    throw new Error("Manifesto não contém o conjunto esperado de dumps de banco de dados.");
  }
  if (JSON.stringify(manifest.database_data_schemas) !== JSON.stringify(["public"])) {
    throw new Error("Manifesto não confirma que o dump de dados está restrito ao schema public.");
  }
  if (typeof manifest.created_at !== "string" || !Number.isFinite(Date.parse(manifest.created_at))) {
    throw new Error("Manifesto não contém uma data de criação válida.");
  }
  for (const filename of [...expectedDatabaseFiles, "RESTORE.md"]) {
    if (!paths.has(filename)) throw new Error(`Arquivo obrigatório ausente: ${filename}`);
  }

  if (!Array.isArray(manifest.migration_files) || manifest.migration_files.length === 0) {
    throw new Error("Manifesto não contém as migrations da aplicação.");
  }
  const migrationPaths = new Set();
  for (const filename of manifest.migration_files) {
    if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".sql")) {
      throw new Error("Manifesto contém o nome de uma migration inválido.");
    }
    migrationPaths.add(`migrations/${filename}`);
  }
  if (migrationPaths.size !== manifest.migration_files.length) throw new Error("Manifesto contém migrations repetidas.");
  const actualMigrationPaths = new Set([...paths].filter(path => path.startsWith("migrations/")));
  if (actualMigrationPaths.size !== migrationPaths.size || [...migrationPaths].some(path => !actualMigrationPaths.has(path))) {
    throw new Error("As migrations no backup não correspondem ao manifesto.");
  }

  const manifestBuckets = backupBucketsForManifest(manifest);
  const bucketNames = [...manifestBuckets].sort();
  for (const field of ["storage_objects", "storage_object_bytes", "storage_files"]) {
    if (!manifest[field] || JSON.stringify(Object.keys(manifest[field]).sort()) !== JSON.stringify(bucketNames)) {
      throw new Error(`Manifesto contém uma lista inválida de buckets em ${field}.`);
    }
  }
  const expectedStoragePaths = new Set();
  for (const bucket of manifestBuckets) {
    const files = manifest.storage_files[bucket];
    if (!Array.isArray(files) || manifest.storage_objects[bucket] !== files.length) {
      throw new Error(`Contagem de objetos inválida para o bucket ${bucket}.`);
    }
    let bucketBytes = 0;
    for (const file of files) {
      if (typeof file.path !== "string" || !file.path || file.path.includes("\\") || file.path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
        throw new Error(`Manifesto contém um caminho de objeto inválido em ${bucket}.`);
      }
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || (file.content_type !== null && typeof file.content_type !== "string") || (file.cache_control !== null && typeof file.cache_control !== "string")) {
        throw new Error(`Metadados inválidos para ${bucket}/${file.path}.`);
      }
      const path = `storage/${bucket}/${file.path}`;
      if (expectedStoragePaths.has(path)) throw new Error(`Manifesto contém um objeto repetido: ${bucket}/${file.path}`);
      expectedStoragePaths.add(path);
      const entry = expected.get(path);
      if (!entry || !paths.has(path) || entry.size !== file.bytes) throw new Error(`Objeto não corresponde ao arquivo salvo: ${bucket}/${file.path}`);
      bucketBytes += file.bytes;
    }
    if (manifest.storage_object_bytes[bucket] !== bucketBytes) throw new Error(`Tamanho total inválido para o bucket ${bucket}.`);
  }
  if (manifest.format_version >= 5) {
    const r2Files = manifest.r2_storage_files;
    if (!Array.isArray(r2Files) || manifest.r2_storage_objects !== r2Files.length
      || !Number.isSafeInteger(manifest.r2_storage_object_bytes) || manifest.r2_storage_object_bytes < 0) {
      throw new Error("Manifesto contém uma lista inválida de originais R2.");
    }
    let r2Bytes = 0;
    for (const file of r2Files) {
      if (typeof file.path !== "string" || !file.path || isAbsolute(file.path) || file.path.includes("\\")
        || file.path.split("/").some(segment => !segment || segment === "." || segment === "..")
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1
        || !["image/jpeg", "image/png"].includes(file.content_type) || !isStrongR2Etag(file.etag)) {
        throw new Error("Manifesto contém metadados inválidos para um original R2.");
      }
      const path = `storage/r2-originals/${file.path}`;
      if (expectedStoragePaths.has(path)) throw new Error(`Manifesto contém um original R2 repetido: ${file.path}`);
      expectedStoragePaths.add(path);
      const entry = expected.get(path);
      if (!entry || !paths.has(path) || entry.size !== file.bytes) throw new Error(`Original R2 não corresponde ao arquivo salvo: ${file.path}`);
      r2Bytes += file.bytes;
      if (!Number.isSafeInteger(r2Bytes)) throw new Error("Tamanho total dos originais R2 inválido.");
    }
    if (manifest.r2_storage_object_bytes !== r2Bytes) throw new Error("Tamanho total dos originais R2 inválido.");
  }
  const actualStoragePaths = new Set([...paths].filter(path => path.startsWith("storage/")));
  if (actualStoragePaths.size !== expectedStoragePaths.size || [...actualStoragePaths].some(path => !expectedStoragePaths.has(path))) {
    throw new Error("Arquivos de Storage não correspondem ao manifesto de objetos.");
  }
  return { valid: true, complete: true, format_version: manifest.format_version, files: actual.length, bytes };
}
