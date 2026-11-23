import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBackup } from "./lib/backup.mjs";
import { prepareBackupDirectory } from "./lib/backup-encryption.mjs";

export async function verifyBackupCommand(argv) {
  if (argv.length !== 1 || argv[0].startsWith("--")) throw new Error("Uso: npm run backup:verify -- DIRETÓRIO-DO-BACKUP");
  const prepared = await prepareBackupDirectory(resolve(argv[0]));
  try {
    const result = { ...(await verifyBackup(prepared.path)), encrypted: prepared.encrypted };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await prepared.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await verifyBackupCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Verificação não concluída."}\n`);
    process.exitCode = 1;
  }
}
