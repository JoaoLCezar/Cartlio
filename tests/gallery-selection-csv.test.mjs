import test from 'node:test';
import assert from 'node:assert/strict';
import { gallerySelectionCsv, gallerySelectionCsvFilename } from '../src/lib/gallery-selection-csv.ts';

test('selection CSV is BOM-prefixed, semicolon-delimited, ordered, and escapes quoted names', () => {
  const csv = gallerySelectionCsv([
    { photo_id: 'photo-1', original_filename: 'IMG; "cerimônia".jpg', client_note: 'Remove reflexo' },
    { photo_id: 'photo-2', original_filename: 'família.png' },
  ]);
  assert.ok(csv.startsWith('\uFEFF"N\u00ba";"Arquivo original";"Observa\u00e7\u00e3o do cliente";"ID da foto"\r\n'));
  assert.ok(csv.includes('"Remove reflexo";"photo-1"'));
  assert.ok(csv.includes('"";"photo-2"'));
});

test('selection CSV neutralizes spreadsheet formulas in uploaded filenames', () => {
  const csv = gallerySelectionCsv([{ photo_id: 'photo-1', original_filename: '=HYPERLINK("https://example.test")' }]);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
});

test('selection CSV filename is a safe, readable slug', () => {
  assert.equal(gallerySelectionCsvFilename('Ensaio: João & Maria!'), 'selecao-ensaio-joao-maria.csv');
  assert.equal(gallerySelectionCsvFilename('!!!'), 'selecao-galeria.csv');
});
