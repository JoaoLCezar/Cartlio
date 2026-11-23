import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertBackupOutsideProject, backupBuckets, copyStorageBucket, copyWorkspaceMigrations, localDatabaseDumps, parseBackupArguments, verifyBackup, writeBackupManifest } from "./lib/backup.mjs";
import { encryptBackupDirectory, prepareBackupDirectory, requireBackupPassphrase } from "./lib/backup-encryption.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = join(process.env.LOCALAPPDATA ?? homedir(), "CartlioBackups");
const windows = process.platform === "win32";

function runSupabase(args) {
  try {
    execFileSync("supabase", args, {
      cwd: projectRoot,
      encoding: "utf8",
      shell: windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
    });
  } catch {
    throw new Error(`Supabase CLI command failed: ${args.slice(0, 3).join(" ")}`);
  }
}

async function dumpFile(backupPath, filename, args) {
  const outputPath = join(backupPath, filename);
  runSupabase([...args, "--file", outputPath]);
  const result = await stat(outputPath).catch(() => null);
  if (!result?.isFile() || result.size === 0) throw new Error(`O dump ${filename} ficou vazio.`);
}

function getLocalCredentials() {
  let status;
  try {
    const output = execFileSync("supabase", ["status", "-o", "json"], {
      cwd: projectRoot,
      encoding: "utf8",
      shell: windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
    });
    status = JSON.parse(output.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("N\u00e3o foi poss\u00edvel acessar o Supabase local. Inicie o banco e os buckets antes do backup.");
  }
  if (!status.API_URL || !status.SERVICE_ROLE_KEY) throw new Error("O status local n\u00e3o retornou as credenciais necess\u00e1rias.");
  return { apiUrl: status.API_URL, serviceRoleKey: status.SERVICE_ROLE_KEY };
}

function restoreInstructions() {
  return [
    "# Restauração deste backup",
    "",
    "Este backup contém dumps lógicos do Postgres, dados dos usuários do Supabase Auth, uma cópia das migrations da aplicação e os bytes dos quatro buckets privados do Quadrics. `auth-data.sql` exporta Auth separadamente; `data.sql` inclui somente o schema `public`; os objetos do Storage são copiados pela API, sem duplicar `storage.objects` no dump SQL. Importe Auth antes dos dados da aplicação. Nunca importe estes dados sobre o banco de desenvolvimento atual ou um projeto de produção.",
    "",
    "A rotina de restauração inicia uma instância Supabase descartável, reaplica as migrations arquivadas, importa usuários Auth e dados da aplicação, recria os buckets e restaura os objetos pela API. Execute `npm run backup:restore-check -- --backup <diretório-do-backup>` para comparar linhas e hashes. A rotina remove somente a instância temporária; ela não altera o projeto local `cartlio`.",
    "O ensaio também confere se fotos ativas e derivados prontos apontam para objetos do backup. Quando encontra um membro com e-mail, usa um link temporário na instância descartável para verificar acesso aos dados e arquivos existentes, sem alterar a senha original.",
    "Para testar login pela interface, envio e processamento de fotos, preview privado, seleção do cliente e download autorizado do original, execute `npm run backup:restore-e2e -- --backup <diretório-do-backup>`. O ensaio não altera o projeto original; ele usa uma instância descartável, cria dados sintéticos e, para testar um membro restaurado sem credenciais conhecidas, troca a senha somente na cópia temporária.",
    "A restauração local reaplica as configurações das roles, exceto a permissão gerenciada do Supabase para `log_min_messages`, que o papel local `postgres` não pode conceder. Essa ACL pertence à plataforma, não aos dados das galerias.",
    "Após restaurar, os usuários precisarão entrar novamente: a instância de destino tem uma chave JWT própria e as sessões antigas não são portáveis. Preserve os arquivos de configuração/segredos do ambiente separadamente quando houver integrações OAuth ou outros segredos externos.",
    "Use também as etapas aplicáveis da [documentação oficial do Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) e consulte [a migração de usuários Auth](https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects).",
    "",
    "Verifique a estrutura e os hashes com `npm run backup:verify -- <diretório-do-backup>`; para comprovar a restauração local, use `backup:restore-check`. Dumps no formato 1 ou 2 são considerados incompletos e não são aceitos pelo ensaio.",
    "Arquivos `.cartlio.enc` podem ser passados diretamente a `backup:verify`, `backup:restore-check` e `backup:restore-e2e`; defina `QUADRICS_BACKUP_PASSPHRASE` no processo antes de executar esses comandos.",
    "",
  ].join("\n");
}

async function runBackup(argv) {
  const options = parseBackupArguments(argv, defaultOutput);
  const passphrase = options.encrypt && !options.dryRun ? requireBackupPassphrase() : null;
  const outputRoot = assertBackupOutsideProject(options.output, projectRoot);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ mode: "local", dry_run: true, encrypted: options.encrypt, output: outputRoot, database: localDatabaseDumps.map(dump => dump.filename), migrations: "supabase/migrations/*.sql", buckets: backupBuckets })}\n`);
    return;
  }

  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const realProjectRoot = await realpath(projectRoot);
  const realOutputRoot = assertBackupOutsideProject(await realpath(outputRoot), realProjectRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(realOutputRoot, `cartlio-${stamp}-${randomUUID().slice(0, 8)}`);
  await mkdir(backupPath, { mode: 0o700 });
  await writeFile(join(backupPath, "INCOMPLETE"), "Backup not yet validated. Do not restore this directory.\n", { mode: 0o600 });

  let backupComplete = false;
  let encryptedArchivePath;
  let encryptedArchiveVerified = false;
  let plaintextRemoved = false;
  try {
    const { apiUrl, serviceRoleKey } = getLocalCredentials();
    const migrationFiles = (await readdir(join(projectRoot, "supabase", "migrations"))).filter(file => file.endsWith(".sql")).sort();
    if (!migrationFiles.length) throw new Error("N\u00e3o foram encontradas migrações para identificar o schema.");

    await copyWorkspaceMigrations(join(projectRoot, "supabase", "migrations"), join(backupPath, "migrations"), migrationFiles);
    for (const dump of localDatabaseDumps) await dumpFile(backupPath, dump.filename, dump.args);

    const storage = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false } }).storage;
    const { data: buckets, error: bucketsError } = await storage.listBuckets();
    if (bucketsError) throw new Error(`N\u00e3o foi poss\u00edvel listar os buckets: ${bucketsError.message}`);
    const availableBuckets = new Set((buckets ?? []).map(bucket => bucket.name));
    const storageCounts = {};
    for (const bucket of backupBuckets) {
      if (!availableBuckets.has(bucket)) throw new Error(`O bucket privado ${bucket} n\u00e3o est\u00e1 dispon\u00edvel.`);
      const bucketDirectory = join(backupPath, "storage", bucket);
      await mkdir(bucketDirectory, { recursive: true, mode: 0o700 });
      storageCounts[bucket] = await copyStorageBucket(storage, bucket, bucketDirectory);
    }

    await writeFile(join(backupPath, "RESTORE.md"), restoreInstructions(), { mode: 0o600 });
    const manifest = await writeBackupManifest(backupPath, {
      database_files: localDatabaseDumps.map(dump => dump.filename),
      database_data_schemas: ["public"],
      storage_objects: Object.fromEntries(Object.entries(storageCounts).map(([bucket, files]) => [bucket, files.length])),
      migration_files: migrationFiles,
      storage_files: storageCounts,
      storage_object_bytes: Object.fromEntries(Object.entries(storageCounts).map(([bucket, files]) => [bucket, files.reduce((total, file) => total + file.bytes, 0)])),
    });
    await rm(join(backupPath, "INCOMPLETE"));
    const verified = await verifyBackup(backupPath);
    if (!verified.complete) throw new Error("O backup foi verificado, mas está incompleto para restauração.");
    backupComplete = true;
    const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
    if (!options.encrypt) {
      process.stdout.write(`${JSON.stringify({ backup: backupPath, files: manifest.files.length, bytes, storage_objects: manifest.storage_objects })}\n`);
      return;
    }

    encryptedArchivePath = join(realOutputRoot, `${basename(backupPath)}.cartlio.enc`);
    await encryptBackupDirectory(backupPath, encryptedArchivePath, passphrase);
    const prepared = await prepareBackupDirectory(encryptedArchivePath, passphrase);
    let archiveVerification;
    try {
      archiveVerification = await verifyBackup(prepared.path);
      if (!archiveVerification.complete) throw new Error("O arquivo criptografado não contém um backup completo.");
    } finally {
      await prepared.cleanup();
    }
    encryptedArchiveVerified = true;
    const archiveBytes = (await stat(encryptedArchivePath)).size;
    await rm(backupPath, { recursive: true, force: false });
    plaintextRemoved = true;
    process.stdout.write(`${JSON.stringify({ backup: encryptedArchivePath, encrypted: true, files: archiveVerification.files, bytes, archive_bytes: archiveBytes, storage_objects: manifest.storage_objects })}\n`);
  } catch (error) {
    if (!backupComplete) {
      await writeFile(join(backupPath, "INCOMPLETE"), "Backup not yet validated. Do not restore this directory.\n", { mode: 0o600 }).catch(() => {});
    }
    if (encryptedArchiveVerified) {
      const cleanupStatus = plaintextRemoved
        ? "O backup cifrado validado permanece disponível."
        : `O backup cifrado validado permanece em ${encryptedArchivePath}; confira a pasta em claro ${backupPath}, pois a limpeza não foi concluída.`;
      process.stderr.write(`${error instanceof Error ? error.message : "Backup cleanup failed."}\n${cleanupStatus}\n`);
      process.exitCode = 1;
      return;
    }
    if (backupComplete) {
      process.stderr.write(`${error instanceof Error ? error.message : "Backup encryption failed."}\nA cópia íntegra sem criptografia foi mantida em ${backupPath}; nenhum dado foi removido.\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : "Backup não concluído."}\nBackup incompleto mantido em ${backupPath}; não restaure esse diretório.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runBackup(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Backup não concluído."}\n`);
    process.exitCode = 1;
  }
}
