import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { backupBuckets, backupBucketsForManifest, copyWorkspaceMigrations, verifyBackup } from "./lib/backup.mjs";
import { prepareBackupDirectory } from "./lib/backup-encryption.mjs";
import { preserveNextTypeFiles } from "./lib/preserve-next-type-files.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const restoreSqlFiles = [
  "roles.sql",
  "auth-data.sql",
  "data.sql",
];
const migrationRestoreStep = "supabase migration up --local (migrations from backup)";
const excludedServices = "realtime,imgproxy,studio,edge-runtime,logflare,vector,supavisor,postgres-meta";

export function parseRestoreCheckArguments(argv) {
  const options = { backup: null, dryRun: false, e2e: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--backup" && argv[index + 1]) options.backup = resolve(argv[++index]);
    else if (argument === "--dry-run" && !options.dryRun) options.dryRun = true;
    else if (argument === "--e2e" && !options.e2e) options.e2e = true;
    else throw new Error("Uso: npm run backup:restore-check -- --backup DIRETÓRIO-DO-BACKUP [--dry-run] [--e2e]");
  }
  if (options.dryRun && options.e2e) throw new Error("--dry-run não pode ser combinado com --e2e.");
  if (!options.backup) throw new Error("Informe o backup com --backup DIRETÓRIO-DO-BACKUP.");
  return options;
}

function run(command, args, cwd, timeout = 180_000, shell = windows, envOverrides = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell,
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...envOverrides, SUPABASE_TELEMETRY_DISABLED: "1" },
  });
  if (result.error || result.status !== 0) {
    const details = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .split(/\r?\n/)
      .filter(line => /error|failed|failure|timeout|already allocated|not found|unknown|fatal|invalid|no files matched/i.test(line))
      .filter(line => !/secret|token|password|jwt|s3_protocol|service_role|publishable|anon_key/i.test(line))
      .map(line => line.replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted]")
        .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted database URL]"))
      .slice(-5);
    const diagnostic = details.length ? ` ${details.join(" | ")}` : "";
    throw new Error(`O comando ${command} falhou${result.status === null ? " por timeout" : ` (código ${result.status})`}.${diagnostic}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runSupabase(workdir, args, timeout) {
  return run("supabase", ["--workdir", workdir, ...args], projectRoot, timeout);
}

function parseJsonOutput(output) {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("A CLI local não retornou o estado esperado.");
  try {
    return JSON.parse(output.slice(first, last + 1));
  } catch {
    throw new Error("A CLI local retornou um estado inválido.");
  }
}

async function choosePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  if (!address || typeof address === "string") throw new Error("Não foi possível reservar uma porta local.");
  return address.port;
}

async function removeRestoreBuild(buildDirectory) {
  const root = await realpath(projectRoot);
  const target = resolve(root, buildDirectory);
  const relativeTarget = relative(root, target);
  if (!/^build-cartlio-restore-[a-f0-9]{8}$/.test(buildDirectory)
    || !relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error("The temporary Next.js build path did not pass safety validation.");
  }
  await rm(target, { recursive: true, force: true });
}

async function runRestoredAppE2E({ apiUrl, publishableKey, serviceRoleKey, projectId }) {
  const baseURL = `http://127.0.0.1:${await choosePort()}`;
  const buildDirectory = `build-${projectId}`;
  const environment = {
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SERVER_SECRET_KEY: serviceRoleKey,
    QUADRICS_TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for",
    QUADRICS_TEST_SUPABASE_URL: apiUrl,
    QUADRICS_TEST_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    QUADRICS_TEST_SUPABASE_SECRET_KEY: serviceRoleKey,
    QUADRICS_TEST_RESTORE_PROJECT_ID: projectId,
    PLAYWRIGHT_BASE_URL: baseURL,
    QUADRICS_APP_URL: baseURL,
    QUADRICS_NEXT_DIST_DIR: buildDirectory,
    QUADRICS_NEXT_TSCONFIG: "tsconfig.e2e.json",
    HOSTNAME: "127.0.0.1",
    PORT: new URL(baseURL).port,
    NEXT_TELEMETRY_DISABLED: "1",
    SUPABASE_TELEMETRY_DISABLED: "1",
  };
  const nextBin = join(projectRoot, "node_modules", "next", "dist", "bin", "next");
  try {
    await preserveNextTypeFiles(projectRoot, () =>
      run(process.execPath, [nextBin, "build"], projectRoot, 360_000, false, environment));
  } catch (error) {
    await removeRestoreBuild(buildDirectory);
    throw error;
  }

  const standaloneLauncher = join(projectRoot, "scripts", "start-standalone.mjs");
  const server = spawn(process.execPath, [standaloneLauncher], {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let serverError = false;
  server.once("error", () => { serverError = true; });
  try {
    const deadline = Date.now() + 60_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (serverError) throw new Error("Could not start the temporary Next.js server.");
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("The temporary Next.js server exited before becoming ready.");
      try {
        const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { healthy = true; break; }
      } catch { /* Wait for the server to start. */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
    }
    if (!healthy) throw new Error("The temporary Next.js server did not become ready in time.");
    const playwrightCli = join(projectRoot, "node_modules", "@playwright", "test", "cli.js");
    run(process.execPath, [playwrightCli, "test", "--config=playwright.config.ts", "tests/e2e/restored-instance.spec.ts"], projectRoot, 240_000, false, environment);
    return { passed: true };
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const closed = new Promise(resolveClose => server.once("close", resolveClose));
      server.kill();
      await Promise.race([closed, new Promise(resolveWait => setTimeout(resolveWait, 5_000))]);
    }
    if (server.exitCode === null && server.signalCode === null) throw new Error("The temporary Next.js server could not be stopped safely.");
    await removeRestoreBuild(buildDirectory);
  }
}

function setTomlValue(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  const sectionHeader = new RegExp(`^\\s*\\[${section.replaceAll(".", "\\.")}\\]\\s*(?:#.*)?$`);
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[index])) continue;
    if (sectionStart >= 0) {
      sectionEnd = index;
      break;
    }
    if (sectionHeader.test(lines[index])) sectionStart = index;
  }
  if (sectionStart < 0) return `${text.trimEnd()}\n\n[${section}]\n${key} = ${value}\n`;
  const property = new RegExp(`^\\s*${key.replaceAll(".", "\\.")}\\s*=`);
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (property.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return `${lines.join("\n")}\n`;
    }
  }
  lines.splice(sectionEnd, 0, `${key} = ${value}`);
  return `${lines.join("\n")}\n`;
}

export function isolatedSupabaseConfig(source, projectId, ports) {
  let config = source.replace(/^project_id\s*=.*$/m, `project_id = "${projectId}"`);
  if (!/^project_id\s*=/m.test(config)) throw new Error("A configuração Supabase não contém project_id.");
  config = setTomlValue(config, "api", "port", ports.api);
  config = setTomlValue(config, "db", "port", ports.db);
  config = setTomlValue(config, "db", "shadow_port", ports.shadow);
  const smtpSection = /^\s*\[local_smtp\]\s*$/m.test(config) ? "local_smtp" : "inbucket";
  config = setTomlValue(config, smtpSection, "port", ports.mail);
  config = setTomlValue(config, smtpSection, "smtp_port", ports.smtp);
  config = setTomlValue(config, smtpSection, "pop3_port", ports.pop3);
  config = setTomlValue(config, "db.seed", "enabled", "false");
  return config;
}

export function prepareRoleDump(sql) {
  return sql.replace(/^\s*GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";\s*$/gm, "-- Supabase-managed parameter ACL is not restorable by the local postgres role.\n");
}

function parseCopyHeader(line) {
  const match = line.match(/^COPY\s+((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?)\s+\(/i);
  if (!match) return null;
  const identifiers = match[1].split(".").map(identifier => identifier.replace(/^"|"$/g, "").replaceAll('""', '"'));
  const [schema, table] = identifiers.length === 2 ? identifiers : ["public", identifiers[0]];
  if (![schema, table].every(identifier => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier))) {
    throw new Error("Um dump contém identificador de tabela não suportado.");
  }
  return { schema, table };
}

export async function countRowsInCopyDumps(root, filenames) {
  const counts = new Map();
  for (const filename of filenames) {
    let current = null;
    const input = createReadStream(join(root, filename), { encoding: "utf8" });
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (current) {
        if (line === "\\.") {
          counts.set(`${current.schema}.${current.table}`, current);
          current = null;
        } else current.rows += 1;
        continue;
      }
      const table = parseCopyHeader(line);
      if (table) current = { ...table, rows: 0 };
    }
    if (current) throw new Error(`O dump ${filename} contém um bloco COPY incompleto.`);
  }
  return [...counts.values()].sort((left, right) => `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`));
}

export function rowCountDifferences(expectedRows, actualRows) {
  const actualByTable = new Map(actualRows.map(row => [row.table, row.rows]));
  return expectedRows.flatMap(({ schema, table, rows }) => {
    const name = `${schema}.${table}`;
    const actual = actualByTable.get(name);
    return actual === rows ? [] : [{ table: name, expected: rows, actual: actual ?? null }];
  });
}

export function auditRestoredPhotoStorage(photos, storageFiles, tenants = []) {
  const bucketPaths = Object.fromEntries(backupBuckets.map(bucket => [
    bucket,
    new Set((storageFiles[bucket] ?? []).map(file => file.path)),
  ]));
  const samplesByTenant = new Map();
  let activePhotos = 0;
  let readyPhotos = 0;
  let missingOriginals = 0;
  let missingDerivatives = 0;
  let missingBrandAssets = 0;

  for (const photo of photos) {
    if (photo.deletion_requested_at != null) continue;
    activePhotos += 1;
    const hasOriginal = bucketPaths["gallery-originals"].has(photo.object_path);
    if (!hasOriginal) missingOriginals += 1;
    const derivativePath = `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`;
    const hasDerivatives = bucketPaths["gallery-previews"].has(derivativePath)
      && bucketPaths["gallery-thumbnails"].has(derivativePath);
    if (photo.processing_status === "ready") {
      readyPhotos += 1;
      if (!hasDerivatives) missingDerivatives += 1;
    }
    if (!hasOriginal) continue;

    const samples = samplesByTenant.get(photo.tenant_id) ?? { photo: null, readyPhoto: null };
    if (!samples.photo) samples.photo = photo;
    if (photo.processing_status === "ready" && hasDerivatives && !samples.readyPhoto) samples.readyPhoto = photo;
    samplesByTenant.set(photo.tenant_id, samples);
  }

  for (const tenant of tenants) {
    if (tenant.brand_logo_path && !bucketPaths["gallery-brand-assets"].has(tenant.brand_logo_path)) {
      missingBrandAssets += 1;
    }
  }

  return {
    active_photos: activePhotos,
    ready_photos: readyPhotos,
    missing_originals: missingOriginals,
    missing_derivatives: missingDerivatives,
    brand_logos_examined: tenants.filter(tenant => tenant.brand_logo_path).length,
    missing_brand_assets: missingBrandAssets,
    samples_by_tenant: samplesByTenant,
  };
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function importSqlFile(containerName, backupRoot, filename) {
  await new Promise((resolveImport, rejectImport) => {
    let diagnostic = "";
    const child = spawn("docker", [
      "exec", "-i", containerName, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    child.stderr.on("data", chunk => {
      const output = chunk.toString("utf8");
      if (!/ERROR:/i.test(output)) return;
      diagnostic = /duplicate key/i.test(output) ? "unique constraint conflict"
        : /foreign key/i.test(output) ? "foreign key conflict"
          : /permission denied/i.test(output) ? "database permission conflict"
            : /does not exist/i.test(output) ? "missing database object"
              : "Postgres rejected a statement";
    });
    child.once("error", () => rejectImport(new Error(`Não foi possível importar ${filename} no banco descartável.`)));
    child.once("close", code => code === 0
      ? resolveImport()
      : rejectImport(new Error(`A importação de ${filename} falhou no banco descartável${diagnostic ? `: ${diagnostic}` : ""}.`)));
    if (filename === "roles.sql") {
      readFile(join(backupRoot, filename), "utf8")
        .then(content => Readable.from([prepareRoleDump(content)]).pipe(child.stdin))
        .catch(() => child.stdin.destroy(new Error("Não foi possível ler o dump de roles.")));
    } else createReadStream(join(backupRoot, filename)).pipe(child.stdin);
  });
}

function queryDatabaseRows(containerName, tables) {
  if (!tables.length) return [];
  const sql = tables.map(({ schema, table }) => {
    const name = `${schema}.${table}`;
    return `SELECT '${name}' || '|' || count(*)::text FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)};`;
  }).join("\n");
  const { stdout } = run("docker", [
    "exec", "-i", containerName, "psql", "-X", "-A", "-t", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], projectRoot, 30_000, false);
  return stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const [table, count] = line.split("|");
    return { table, rows: Number(count) };
  });
}

function projectContainer(workdir, projectId) {
  const { stdout } = run("docker", ["ps", "--filter", `label=com.supabase.cli.project=${projectId}`, "--format", "{{.Names}}"], projectRoot, 30_000, false);
  const expectedName = `supabase_db_${projectId}`;
  if (!stdout.split(/\r?\n/).includes(expectedName)) throw new Error("O banco isolado da restauração não está ativo.");
  const { stdout: inspect } = run("docker", ["inspect", expectedName], projectRoot, 30_000, false);
  const containerDetails = JSON.parse(inspect)[0];
  if (resolve(containerDetails?.Config?.Labels?.["com.supabase.cli.workdir"] ?? "") !== resolve(workdir)) {
    throw new Error("O container encontrado não pertence à pasta temporária da restauração.");
  }
  return expectedName;
}

async function restoreStorage(client, backupRoot, manifest) {
  const hashes = new Map(manifest.files.map(file => [file.path, file.sha256]));
  for (const bucket of backupBucketsForManifest(manifest)) {
    const bucketStorage = client.storage.from(bucket);
    for (const item of manifest.storage_files[bucket]) {
      const fullPath = join(backupRoot, "storage", bucket, ...item.path.split("/"));
      const bytes = await readFile(fullPath);
      const cacheControl = item.cache_control?.match(/max-age=(\d+)/i)?.[1] ?? "3600";
      const { error } = await bucketStorage.upload(item.path, bytes, {
        contentType: item.content_type ?? undefined,
        cacheControl,
        upsert: false,
      });
      if (error) throw new Error(`Falha ao restaurar um objeto do bucket ${bucket}.`);
      const { data, error: downloadError } = await bucketStorage.download(item.path);
      if (downloadError || !data) throw new Error(`Não foi possível validar um objeto restaurado do bucket ${bucket}.`);
      const restored = Buffer.from(await data.arrayBuffer());
      const expectedHash = hashes.get(`storage/${bucket}/${item.path}`);
      if (restored.length !== item.bytes || createHash("sha256").update(restored).digest("hex") !== expectedHash) {
        throw new Error(`A validação dos bytes de um objeto do bucket ${bucket} falhou.`);
      }
    }
  }
}

async function countAuthUsers(client) {
  let total = 0;
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("A API de Auth não conseguiu listar os usuários restaurados.");
    total += data.users.length;
    if (data.users.length < 1000) return total;
  }
}

async function listRestoredTenantMembers(client) {
  const members = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from("tenant_members")
      .select("tenant_id, user_id")
      .order("tenant_id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error("Não foi possível conferir os membros restaurados.");
    members.push(...(data ?? []));
    if (!data || data.length < pageSize) return members;
  }
}

async function auditRestoredPhotoRecords(client, manifest) {
  const result = {
    active_photos: 0,
    ready_photos: 0,
    missing_originals: 0,
    missing_derivatives: 0,
    brand_logos_examined: 0,
    missing_brand_assets: 0,
    samples_by_tenant: new Map(),
  };
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from("photos")
      .select("id, tenant_id, gallery_id, object_path, processing_status, deletion_requested_at")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error("Não foi possível conferir os arquivos ligados às fotos restauradas.");
    const page = auditRestoredPhotoStorage(data ?? [], manifest.storage_files);
    result.active_photos += page.active_photos;
    result.ready_photos += page.ready_photos;
    result.missing_originals += page.missing_originals;
    result.missing_derivatives += page.missing_derivatives;
    for (const [tenantId, samples] of page.samples_by_tenant) {
      const current = result.samples_by_tenant.get(tenantId) ?? { photo: null, readyPhoto: null };
      if (!current.photo) current.photo = samples.photo;
      if (!current.readyPhoto) current.readyPhoto = samples.readyPhoto;
      result.samples_by_tenant.set(tenantId, current);
    }
    if (!data || data.length < pageSize) {
      if (manifest.format_version >= 4) {
        for (let tenantOffset = 0; ; tenantOffset += pageSize) {
          const { data: tenants, error: tenantError } = await client.from("tenants")
            .select("id, brand_logo_path")
            .not("brand_logo_path", "is", null)
            .order("id", { ascending: true })
            .range(tenantOffset, tenantOffset + pageSize - 1);
          if (tenantError) throw new Error("Não foi possível conferir os logos restaurados.");
          const tenantPage = auditRestoredPhotoStorage([], manifest.storage_files, tenants ?? []);
          result.brand_logos_examined += tenantPage.brand_logos_examined;
          result.missing_brand_assets += tenantPage.missing_brand_assets;
          if (!tenants || tenants.length < pageSize) break;
        }
      }
      return result;
    }
  }
}

async function verifyExistingRestoredMember({ client, apiUrl, publishableKey, manifest }) {
  const photos = await auditRestoredPhotoRecords(client, manifest);
  if (photos.missing_brand_assets) {
    throw new Error("Um ou mais logos restaurados não correspondem aos objetos do Storage.");
  }
  if (photos.missing_originals || photos.missing_derivatives) {
    throw new Error(`Os metadados de ${photos.missing_originals} originais e ${photos.missing_derivatives} derivados não correspondem aos objetos restaurados.`);
  }

  const members = await listRestoredTenantMembers(client);
  const orderedMembers = [...members].sort((left, right) => {
    const leftSamples = photos.samples_by_tenant.get(left.tenant_id);
    const rightSamples = photos.samples_by_tenant.get(right.tenant_id);
    const leftRank = leftSamples?.readyPhoto ? 0 : leftSamples?.photo ? 1 : 2;
    const rightRank = rightSamples?.readyPhoto ? 0 : rightSamples?.photo ? 1 : 2;
    return leftRank - rightRank;
  });
  let selected = null;
  for (const membership of orderedMembers) {
    const { data, error } = await client.auth.admin.getUserById(membership.user_id);
    if (error) throw new Error("Não foi possível conferir uma conta vinculada aos workspaces restaurados.");
    if (data.user?.email) {
      selected = { membership, email: data.user.email };
      break;
    }
  }

  const summary = {
    photo_records_checked: photos.active_photos,
    ready_photo_records_checked: photos.ready_photos,
    existing_member_session: false,
    workspace_access: false,
    existing_gallery_access: false,
    existing_original_download: false,
    existing_preview_download: false,
  };
  if (!selected) return summary;

  const { data: generated, error: linkError } = await client.auth.admin.generateLink({
    type: "magiclink",
    email: selected.email,
  });
  if (linkError || !generated?.properties?.hashed_token) {
    throw new Error("Não foi possível emitir uma sessão temporária para uma conta restaurada.");
  }
  const memberClient = createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: sessionError } = await memberClient.auth.verifyOtp({
    token_hash: generated.properties.hashed_token,
    type: "magiclink",
  });
  if (sessionError || session.user?.id !== selected.membership.user_id) {
    throw new Error("Uma conta restaurada não conseguiu iniciar uma sessão temporária.");
  }

  const { data: tenant, error: tenantError } = await memberClient.from("tenants")
    .select("id")
    .eq("id", selected.membership.tenant_id)
    .maybeSingle();
  if (tenantError || tenant?.id !== selected.membership.tenant_id) {
    throw new Error("A conta restaurada não consegue acessar seu workspace.");
  }
  summary.existing_member_session = true;
  summary.workspace_access = true;

  const samples = photos.samples_by_tenant.get(selected.membership.tenant_id);
  const photo = samples?.readyPhoto ?? samples?.photo;
  if (!photo) return summary;

  const { data: gallery, error: galleryError } = await memberClient.from("galleries")
    .select("id")
    .eq("tenant_id", photo.tenant_id)
    .eq("id", photo.gallery_id)
    .maybeSingle();
  const { data: visiblePhoto, error: photoError } = await memberClient.from("photos")
    .select("id, object_path")
    .eq("tenant_id", photo.tenant_id)
    .eq("id", photo.id)
    .maybeSingle();
  if (galleryError || gallery?.id !== photo.gallery_id || photoError || visiblePhoto?.id !== photo.id) {
    throw new Error("A conta restaurada não consegue acessar uma galeria e uma foto existentes.");
  }
  summary.existing_gallery_access = true;

  const { data: original, error: originalError } = await memberClient.storage
    .from("gallery-originals").download(photo.object_path);
  if (originalError || !original || original.size === 0) {
    throw new Error("A conta restaurada não consegue baixar um original existente.");
  }
  summary.existing_original_download = true;

  if (photo.processing_status === "ready") {
    const derivativePath = `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`;
    for (const bucket of ["gallery-previews", "gallery-thumbnails"]) {
      const { data: derivative, error: derivativeError } = await memberClient.storage.from(bucket).download(derivativePath);
      if (derivativeError || !derivative || derivative.size === 0) {
        throw new Error("A conta restaurada não consegue acessar um preview existente.");
      }
    }
    summary.existing_preview_download = true;
  }
  return summary;
}

async function safeRemoveWorkdir(workdir, projectId) {
  const temporaryRoot = await realpath(tmpdir());
  const target = await realpath(workdir);
  const relativeTarget = relative(temporaryRoot, target);
  if (!basename(target).startsWith("cartlio-restore-") || !relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error("A pasta temporária não passou pela validação de segurança e foi mantida.");
  }
  const config = await readFile(join(target, "supabase", "config.toml"), "utf8");
  if (!config.includes(`project_id = "${projectId}"`)) throw new Error("O projeto temporário não corresponde ao identificador esperado.");
  await rm(target, { recursive: true, force: true });
}

export async function runRestoreCheck(argv) {
  const options = parseRestoreCheckArguments(argv);
  const prepared = await prepareBackupDirectory(options.backup);
  try {
    return { ...(await runRestoreCheckDirectory({ ...options, backup: prepared.path })), backup_encrypted: prepared.encrypted };
  } finally {
    await prepared.cleanup();
  }
}

async function runRestoreCheckDirectory(options) {
  const backup = await verifyBackup(options.backup);
  if (!backup.complete) throw new Error("O backup foi verificado, mas está incompleto para restauração.");
  const manifest = JSON.parse(await readFile(join(options.backup, "manifest.json"), "utf8"));
  if (options.dryRun) {
    return {
      valid: true,
      complete: true,
      dry_run: true,
      restore_order: ["roles.sql", migrationRestoreStep, "auth-data.sql", "data.sql", "Storage API objects"],
      target: "instância Supabase descartável",
    };
  }

  const startedAt = Date.now();
  const workdir = await mkdtemp(join(tmpdir(), "cartlio-restore-"));
  const projectId = `cartlio-restore-${randomUUID().slice(0, 8)}`;
  const supabaseDirectory = join(workdir, "supabase");
  await mkdir(supabaseDirectory, { recursive: true });
  const ports = {
    api: await choosePort(), db: await choosePort(), shadow: await choosePort(),
    mail: await choosePort(), smtp: await choosePort(), pop3: await choosePort(),
  };
  const originalConfig = await readFile(join(projectRoot, "supabase", "config.toml"), "utf8");
  await writeFile(join(supabaseDirectory, "config.toml"), isolatedSupabaseConfig(originalConfig, projectId, ports), { mode: 0o600 });

  let startAttempted = false;
  let failure;
  let result;
  try {
    await copyWorkspaceMigrations(join(options.backup, "migrations"), join(supabaseDirectory, "migrations"), manifest.migration_files);
    startAttempted = true;
    runSupabase(workdir, ["start", "--exclude", excludedServices], 240_000);
    const status = parseJsonOutput(runSupabase(workdir, ["status", "--output", "json"], 30_000).stdout);
    const serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
    if (!status.API_URL || !serviceRoleKey) throw new Error("A instância descartável não retornou as credenciais locais necessárias.");
    const container = projectContainer(workdir, projectId);
    await importSqlFile(container, options.backup, "roles.sql");
    runSupabase(workdir, ["migration", "up", "--local"], 240_000);
    runSupabase(workdir, ["seed", "buckets", "--local"], 60_000);
    for (const filename of restoreSqlFiles.slice(1)) await importSqlFile(container, options.backup, filename);

    const expectedRows = await countRowsInCopyDumps(options.backup, ["auth-data.sql", "data.sql", "migration-history-data.sql"]);
    const actualRows = queryDatabaseRows(container, expectedRows);
    const differences = rowCountDifferences(expectedRows, actualRows);
    if (differences.length) {
      const summary = differences.slice(0, 5).map(item => `${item.table}: esperado ${item.expected}, encontrado ${item.actual ?? "sem resposta"}`).join("; ");
      throw new Error(`As contagens das tabelas restauradas não correspondem aos dumps: ${summary}.`);
    }

    const client = createClient(status.API_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const authUsers = await countAuthUsers(client);
    const expectedAuthUsers = expectedRows.find(row => row.schema === "auth" && row.table === "users")?.rows ?? 0;
    if (authUsers !== expectedAuthUsers) throw new Error("A quantidade de usuários do Auth restaurados não corresponde ao dump.");
    const { data: buckets, error: bucketsError } = await client.storage.listBuckets();
    if (bucketsError) throw new Error(`A API de Storage não ficou disponível na instância descartável (HTTP ${bucketsError.status ?? "sem status"}, ${bucketsError.name ?? "erro"}).`);
    const actualBuckets = new Set((buckets ?? []).map(bucket => bucket.name));
    if (backupBucketsForManifest(manifest).some(bucket => !actualBuckets.has(bucket))) throw new Error("A instância descartável não contém todos os buckets do backup.");
    await restoreStorage(client, options.backup, manifest);
    const existingData = await verifyExistingRestoredMember({
      client,
      apiUrl: status.API_URL,
      publishableKey: status.PUBLISHABLE_KEY,
      manifest,
    });

    result = {
      valid: true,
      restored: true,
      auth_users: authUsers,
      database_tables: expectedRows.length,
      storage_objects: Object.values(manifest.storage_objects).reduce((sum, value) => sum + value, 0),
      existing_data: existingData,
      isolated_project: true,
      backup_created_at: manifest.created_at,
      backup_age_ms: Math.max(0, Date.now() - Date.parse(manifest.created_at)),
      elapsed_ms: Date.now() - startedAt,
    };
    if (options.e2e) result.e2e = await runRestoredAppE2E({
      apiUrl: status.API_URL,
      publishableKey: status.PUBLISHABLE_KEY,
      serviceRoleKey,
      projectId,
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error("O ensaio de restauração falhou.");
  }

  let cleanup = "removed";
  if (startAttempted) {
    try {
      runSupabase(workdir, ["--yes", "stop", "--project-id", projectId, "--no-backup"], 120_000);
    } catch {
      cleanup = "failed";
    }
  }
  if (cleanup === "removed") {
    try {
      await safeRemoveWorkdir(workdir, projectId);
    } catch {
      cleanup = "failed";
    }
  }
  if (cleanup === "failed") {
    const cleanupError = new Error(`A instância de ensaio não pôde ser removida automaticamente. O diretório temporário foi mantido em ${workdir}.`);
    if (failure) throw new AggregateError([failure, cleanupError], "O ensaio falhou e a limpeza automática também falhou.");
    throw cleanupError;
  }
  if (failure) throw failure;
  return { ...result, cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runRestoreCheck(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Ensaio de restauração não concluído."}\n`);
    process.exitCode = 1;
  }
}
