import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const generatedTypeFiles = ["next-env.d.ts", "tsconfig.json", "tsconfig.e2e.json"];

export async function preserveNextTypeFiles(projectRoot, operation) {
  const snapshots = await Promise.all(generatedTypeFiles.map(async name => ({
    path: join(projectRoot, name),
    contents: await readFile(join(projectRoot, name)),
  })));

  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  const restoreErrors = [];
  for (const snapshot of snapshots) {
    try {
      await writeFile(snapshot.path, snapshot.contents);
    } catch (error) {
      restoreErrors.push(error);
    }
  }

  if (restoreErrors.length > 0) {
    throw new AggregateError(
      operationError ? [operationError, ...restoreErrors] : restoreErrors,
      "Next.js generated TypeScript files could not be restored after the temporary build.",
    );
  }
  if (operationError) throw operationError;
  return result;
}
