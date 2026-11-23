import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BATCH_BYTES, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_BATCH,
  RESUMABLE_UPLOAD_THRESHOLD_BYTES, validPhotoSignature, validatePhotoQuota, validatePhotoSelection,
} from '../src/lib/photo-validation.ts';

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const file = (type, size) => ({ type, size });

test('recognizes JPEG and PNG signatures', () => {
  assert.equal(validPhotoSignature('image/jpeg', jpeg), true);
  assert.equal(validPhotoSignature('image/png', png), true);
});

test('rejects mismatched, truncated, and unsupported signatures', () => {
  assert.equal(validPhotoSignature('image/jpeg', png), false);
  assert.equal(validPhotoSignature('image/png', png.subarray(0, 7)), false);
  assert.equal(validPhotoSignature('image/svg+xml', new TextEncoder().encode('<svg/>')), false);
  assert.equal(validPhotoSignature('image/png', jpeg), false);
});

test('rejects an empty upload selection', () => {
  assert.equal(validatePhotoSelection([]), 'Selecione pelo menos uma imagem.');
});

test('accepts one image at the exact per-file limit', () => {
  assert.equal(validatePhotoSelection([file('image/jpeg', MAX_PHOTO_BYTES)]), null);
  assert.equal(MAX_PHOTO_BYTES, 50 * 1024 * 1024);
  assert.equal(RESUMABLE_UPLOAD_THRESHOLD_BYTES, 6 * 1024 * 1024);
});

test('rejects zero-byte, oversized, and unsupported files', () => {
  assert.match(validatePhotoSelection([file('image/jpeg', 0)]), /até 50 MiB/);
  assert.match(validatePhotoSelection([file('image/png', MAX_PHOTO_BYTES + 1)]), /até 50 MiB/);
  assert.match(validatePhotoSelection([file('image/webp', 128)]), /JPEG ou PNG/);
});

test('caps each selection at 20 images', () => {
  assert.equal(validatePhotoSelection(Array.from({ length: MAX_PHOTOS_PER_BATCH }, () => file('image/png', 1))), null);
  assert.match(validatePhotoSelection(Array.from({ length: MAX_PHOTOS_PER_BATCH + 1 }, () => file('image/png', 1))), /no máximo 20/);
});

test('caps a batch at 100 MiB', () => {
  const perFileSize = 5 * 1024 * 1024;
  assert.equal(validatePhotoSelection(Array.from({ length: MAX_PHOTOS_PER_BATCH }, () => file('image/png', perFileSize))), null);
  assert.equal(MAX_PHOTOS_PER_BATCH * perFileSize, MAX_BATCH_BYTES);
  assert.match(validatePhotoSelection(Array.from({ length: MAX_PHOTOS_PER_BATCH }, () => file('image/png', perFileSize + 1))), /100 MiB/);
});

test('checks that every file can reserve 50 MiB before starting the batch', () => {
  const size = 40 * 1024 * 1024;
  assert.equal(validatePhotoQuota([{ size }], MAX_PHOTO_BYTES), null);
  assert.equal(validatePhotoQuota([{ size }, { size }], 120 * 1024 * 1024), null);
  assert.match(validatePhotoQuota([{ size }, { size: 1 }], 80 * 1024 * 1024), /iniciar apenas 1 imagem/);
  assert.match(validatePhotoQuota([{ size: 1 }], MAX_PHOTO_BYTES - 1), /Libere pelo menos 50 MiB/);
});
