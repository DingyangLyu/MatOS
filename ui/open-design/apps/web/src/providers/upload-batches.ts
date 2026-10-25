/** Bound multipart envelopes below the native gateway's 64 MiB body cap. */
export function projectUploadBatches<T extends { size: number }>(files: T[], maxBytes = 32 * 1024 * 1024, maxFiles = 12): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const file of files) {
    if (batch.length && (bytes + file.size > maxBytes || batch.length >= maxFiles)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(file); bytes += file.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
