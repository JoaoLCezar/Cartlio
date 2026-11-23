export type PhotoPageResult<T> = {
  data: T[] | null;
  error: unknown | null;
};

export type GalleryPhotoIdPage = {
  ids: string[] | null;
  totalCount: number | null;
  error: unknown | null;
};

export async function fetchAllGalleryPhotoIds(
  loadPage: (offset: number) => PromiseLike<GalleryPhotoIdPage>,
  pageSize = 1000,
): Promise<string[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive safe integer");

  const ids: string[] = [];
  const seen = new Set<string>();
  let expectedCount: number | null = null;
  for (let offset = 0; ; offset += pageSize) {
    const result = await loadPage(offset);
    if (result.error) throw result.error;
    if (!Array.isArray(result.ids) || (offset === 0 && (!Number.isSafeInteger(result.totalCount) || result.totalCount! < 0))) {
      throw new Error("The gallery photo list changed. Refresh the page and try again.");
    }
    if (offset === 0) expectedCount = result.totalCount;
    else if (result.totalCount !== null && result.totalCount !== expectedCount) {
      throw new Error("The gallery photo list changed. Refresh the page and try again.");
    }

    for (const id of result.ids) {
      if (seen.has(id)) throw new Error("The gallery photo list changed. Refresh the page and try again.");
      seen.add(id);
      ids.push(id);
    }
    if (result.ids.length > pageSize || ids.length > expectedCount!) {
      throw new Error("The gallery photo list changed. Refresh the page and try again.");
    }
    if (ids.length === expectedCount) return ids;
    if (result.ids.length < pageSize) {
      throw new Error("The gallery photo list changed. Refresh the page and try again.");
    }
  }
}

export async function fetchAllPhotoPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<PhotoPageResult<T>>,
  pageSize = 1000,
): Promise<PhotoPageResult<T>> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive safe integer");

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await loadPage(from, from + pageSize - 1);
    if (result.error) return { data: null, error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}

export type SignedPathResult = {
  data: {
    error: string | null;
    path: string | null;
    signedUrl: string | null;
    signedURL?: string | null;
  }[] | null;
  error: unknown | null;
};

export async function signPhotoPathsInBatches(
  paths: readonly string[],
  signBatch: (batch: string[]) => PromiseLike<SignedPathResult>,
  batchSize = 100,
  maxConcurrentBatches = 4,
): Promise<Map<string, string>> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new RangeError("batchSize must be a positive safe integer");
  if (!Number.isSafeInteger(maxConcurrentBatches) || maxConcurrentBatches < 1) {
    throw new RangeError("maxConcurrentBatches must be a positive safe integer");
  }

  const uniquePaths = [...new Set(paths)];
  const batches: string[][] = [];
  for (let from = 0; from < uniquePaths.length; from += batchSize) {
    batches.push(uniquePaths.slice(from, from + batchSize));
  }

  const signedPaths = new Map<string, string>();
  for (let from = 0; from < batches.length; from += maxConcurrentBatches) {
    const responses = await Promise.all(batches.slice(from, from + maxConcurrentBatches).map(signBatch));
    for (const response of responses) {
      if (response.error || !response.data) continue;
      for (const item of response.data) {
        const url = item.signedUrl ?? item.signedURL ?? null;
        if (!item.error && item.path && url) signedPaths.set(item.path, url);
      }
    }
  }
  return signedPaths;
}
