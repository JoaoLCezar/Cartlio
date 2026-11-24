import { quadricsEnv } from "./quadrics-env.mjs";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const MAGIC = Buffer.from("CARTLIO-ENC-1\n", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_METADATA_BYTES = 8192;
const MAX_FILES = 1_000_000;
const IO_CHUNK_BYTES = 1024 * 1024;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = promisify(scryptCallback);

export function requireBackupPassphrase(value = quadricsEnv("BACKUP_PASSPHRASE")) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 16) {
    throw new Error("Set QUADRICS_BACKUP_PASSPHRASE to a passphrase of at least 16 UTF-8 bytes.");
  }
  return value;
}

async function deriveKey(passphrase, salt) {
  return scrypt(requireBackupPassphrase(passphrase), salt, 32, SCRYPT_OPTIONS);
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Encrypted backups cannot contain symbolic links.");
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, fullPath));
    else if (entry.isFile()) {
      const path = relative(root, fullPath).split(sep).join("/");
      if (path === "INCOMPLETE") throw new Error("Cannot encrypt an incomplete backup.");
      if (!isSafeArchivePath(path)) throw new Error("Backup contains an unsupported file path.");
      files.push({ fullPath, path });
    } else throw new Error("Encrypted backups support regular files only.");
  }
  return files;
}

export function isSafeArchivePath(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096 ||
    value.includes("\\") || isAbsolute(value)) return false;
  return value.split("/").every(segment => segment && segment !== "." && segment !== ".." &&
    Buffer.byteLength(segment, "utf8") <= 255 && !/[\u0000-\u001f<>:"|?*]/.test(segment) && !/[. ]$/.test(segment) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment));
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten < 1) throw new Error("Encrypted backup could not be written completely.");
    offset += bytesWritten;
  }
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead < 1) throw new Error("Encrypted backup is truncated.");
    offset += bytesRead;
  }
  return buffer;
}

async function encryptFile(output, { fullPath, path }, key) {
  const info = await lstat(fullPath);
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size)) {
    throw new Error("Backup changed or contains an unsupported file.");
  }
  const metadata = Buffer.from(JSON.stringify({ path, size: info.size }), "utf8");
  if (metadata.length > MAX_METADATA_BYTES) throw new Error("Backup file path metadata is too large to encrypt safely.");
  const metadataIv = randomBytes(IV_BYTES);
  const metadataCipher = createCipheriv("aes-256-gcm", key, metadataIv);
  const encryptedMetadata = Buffer.concat([metadataCipher.update(metadata), metadataCipher.final()]);
  const metadataLength = Buffer.alloc(4);
  metadataLength.writeUInt32BE(encryptedMetadata.length);
  const fileSize = Buffer.alloc(8);
  fileSize.writeBigUInt64BE(BigInt(info.size));
  await writeAll(output, metadataLength);
  await writeAll(output, fileSize);
  await writeAll(output, metadataIv);
  await writeAll(output, encryptedMetadata);
  await writeAll(output, metadataCipher.getAuthTag());

  const payloadIv = randomBytes(IV_BYTES);
  const payloadCipher = createCipheriv("aes-256-gcm", key, payloadIv);
  payloadCipher.setAAD(metadata);
  await writeAll(output, payloadIv);
  const input = await open(fullPath, "r");
  try {
    let position = 0;
    while (position < info.size) {
      const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, info.size - position));
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead !== buffer.length) throw new Error("Backup file changed while it was encrypted.");
      position += bytesRead;
      await writeAll(output, payloadCipher.update(buffer));
    }
    const extra = Buffer.alloc(1);
    if ((await input.read(extra, 0, 1, info.size)).bytesRead !== 0) throw new Error("Backup file changed while it was encrypted.");
  } finally {
    await input.close();
  }
  await writeAll(output, payloadCipher.final());
  await writeAll(output, payloadCipher.getAuthTag());
  const after = await lstat(fullPath);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("Backup file changed while it was encrypted.");
  return info.size;
}

export async function encryptBackupDirectory(sourcePath, archivePath, passphrase) {
  const source = resolve(sourcePath);
  const destination = resolve(archivePath);
  const relation = relative(source, destination);
  if (!relation || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) {
    throw new Error("Encrypted backup must be stored outside its source directory.");
  }
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Backup source must be a regular directory.");
  await lstat(destination).then(() => { throw new Error("Encrypted backup destination already exists."); }, error => {
    if (error?.code !== "ENOENT") throw error;
  });

  const files = (await collectFiles(source)).sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length || files.length > MAX_FILES) throw new Error("Backup contains an unsupported number of files.");
  const portablePaths = new Set();
  for (const file of files) {
    const portablePath = file.path.toLowerCase();
    if (portablePaths.has(portablePath)) throw new Error("Backup contains paths that collide on a case-insensitive filesystem.");
    portablePaths.add(portablePath);
  }
  const passphraseValue = requireBackupPassphrase(passphrase);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(passphraseValue, salt);
  const temporaryPath = join(dirname(destination), `.${basename(destination)}.${randomBytes(8).toString("hex")}.tmp`);

  let output;
  try {
    output = await open(temporaryPath, "wx", 0o600);
    await writeAll(output, MAGIC);
    await writeAll(output, salt);
    let plainBytes = 0;
    for (const file of files) plainBytes += await encryptFile(output, file, key);
    await writeAll(output, Buffer.alloc(4));
    await output.sync();
    await output.close();
    output = null;
    await link(temporaryPath, destination);
    await rm(temporaryPath);
    return { files: files.length, bytes: plainBytes };
  } catch (error) {
    await output?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    key.fill(0);
  }
}

function decryptMetadata(encrypted, iv, tag, key) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("Encrypted backup authentication failed; check the passphrase and file integrity.");
  }
}

async function decryptFile(archive, destination, record, key, archiveSize) {
  const path = resolve(destination, ...record.path.split("/"));
  const withinRoot = relative(destination, path);
  if (!withinRoot || withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
    throw new Error("Encrypted backup contains an unsafe file path.");
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let output;
  try {
    output = await open(temporaryPath, "wx", 0o600);
    const payloadIv = await readExact(archive, IV_BYTES, record.payloadIvPosition);
    const payloadStart = record.payloadIvPosition + IV_BYTES;
    const tagPosition = payloadStart + record.size;
    if (!Number.isSafeInteger(tagPosition) || tagPosition + TAG_BYTES > archiveSize) throw new Error("Encrypted backup is truncated.");
    const payloadTag = await readExact(archive, TAG_BYTES, tagPosition);
    const decipher = createDecipheriv("aes-256-gcm", key, payloadIv);
    decipher.setAAD(record.metadata);
    decipher.setAuthTag(payloadTag);

    let position = payloadStart;
    let remaining = record.size;
    while (remaining > 0) {
      const length = Math.min(IO_CHUNK_BYTES, remaining);
      const encryptedChunk = await readExact(archive, length, position);
      await writeAll(output, decipher.update(encryptedChunk));
      position += length;
      remaining -= length;
    }
    try {
      await writeAll(output, decipher.final());
    } catch {
      throw new Error("Encrypted backup authentication failed; check the passphrase and file integrity.");
    }
    await output.sync();
    await output.close();
    output = null;
    const clearInfo = await lstat(temporaryPath);
    if (clearInfo.size !== record.size) throw new Error("Decrypted file size does not match its authenticated metadata.");
    await rename(temporaryPath, path);
    return tagPosition + TAG_BYTES;
  } catch (error) {
    await output?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function decryptBackupArchive(archivePath, destinationPath, passphrase) {
  const archiveFile = resolve(archivePath);
  const destination = resolve(destinationPath);
  const archiveInfo = await lstat(archiveFile);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error("Encrypted backup must be a regular file.");
  const archive = await open(archiveFile, "r");
  let createdDestination = false;
  let key;
  try {
    const openedInfo = await archive.stat();
    if (!openedInfo.isFile()) throw new Error("Encrypted backup must be a regular file.");
    const archiveSize = openedInfo.size;
    await mkdir(destination, { recursive: false, mode: 0o700 });
    createdDestination = true;
    if (archiveSize < MAGIC.length + SALT_BYTES + 4) throw new Error("Encrypted backup header is invalid.");
    const header = await readExact(archive, MAGIC.length, 0);
    if (!header.equals(MAGIC)) throw new Error("Encrypted backup format is not recognized.");
    const salt = await readExact(archive, SALT_BYTES, MAGIC.length);
    key = await deriveKey(passphrase, salt);
    const seen = new Set();
    let position = MAGIC.length + SALT_BYTES;
    let files = 0;
    let plainBytes = 0;

    while (true) {
      if (position + 4 > archiveSize) throw new Error("Encrypted backup is missing its end marker.");
      const metadataLengthBytes = await readExact(archive, 4, position);
      position += 4;
      const metadataLength = metadataLengthBytes.readUInt32BE(0);
      if (metadataLength === 0) {
        if (position !== archiveSize || files === 0) throw new Error("Encrypted backup has an invalid end marker.");
        break;
      }
      if (metadataLength > MAX_METADATA_BYTES || position + 8 + IV_BYTES + metadataLength + TAG_BYTES > archiveSize) {
        throw new Error("Encrypted backup record header is invalid.");
      }

      const sizeBytes = await readExact(archive, 8, position);
      const sizeValue = sizeBytes.readBigUInt64BE(0);
      if (sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Encrypted backup file is too large to restore safely.");
      const size = Number(sizeValue);
      position += 8;
      const metadataIv = await readExact(archive, IV_BYTES, position);
      position += IV_BYTES;
      const encryptedMetadata = await readExact(archive, metadataLength, position);
      position += metadataLength;
      const metadataTag = await readExact(archive, TAG_BYTES, position);
      position += TAG_BYTES;
      const metadata = decryptMetadata(encryptedMetadata, metadataIv, metadataTag, key);

      let record;
      try { record = JSON.parse(metadata.toString("utf8")); } catch { throw new Error("Encrypted backup metadata is invalid."); }
      const portablePath = typeof record?.path === "string" ? record.path.toLowerCase() : "";
      if (!record || !isSafeArchivePath(record.path) || record.size !== size || seen.has(portablePath)) {
        throw new Error("Encrypted backup metadata contains an invalid or repeated path.");
      }
      seen.add(portablePath);
      const payloadIvPosition = position;
      const nextPosition = await decryptFile(archive, destination, { ...record, metadata, payloadIvPosition }, key, archiveSize);
      position = nextPosition;
      files += 1;
      if (files > MAX_FILES) throw new Error("Encrypted backup contains too many files.");
      plainBytes += size;
    }
    return { files, bytes: plainBytes };
  } catch (error) {
    if (createdDestination) await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    key?.fill(0);
    await archive.close();
  }
}

export async function prepareBackupDirectory(inputPath, passphrase = quadricsEnv("BACKUP_PASSPHRASE")) {
  const source = resolve(inputPath);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("Backup path cannot be a symbolic link.");
  if (info.isDirectory()) return { path: source, encrypted: false, cleanup: async () => {} };
  if (!info.isFile()) throw new Error("Backup path must be a directory or encrypted backup file.");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "cartlio-backup-decrypt-"));
  const destination = join(temporaryRoot, "backup");
  try {
    await decryptBackupArchive(source, destination, passphrase);
    return {
      path: destination,
      encrypted: true,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
