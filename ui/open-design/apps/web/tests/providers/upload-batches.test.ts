import { expect, test } from 'vitest';
import { projectUploadBatches } from '../../src/providers/upload-batches';
test('multipart batches obey byte and count limits without dropping or reordering files', () => {
  const files = [{ size: 24 }, { size: 24 }, ...Array.from({ length: 30 }, () => ({ size: 1 }))];
  const batches = projectUploadBatches(files, 32, 12);
  expect(batches.flat()).toEqual(files);
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(12);
    expect(batch.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(32);
  }
});
