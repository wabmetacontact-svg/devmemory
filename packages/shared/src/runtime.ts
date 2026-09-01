/** Node versions older than 24 either lack node:sqlite or hide it behind a flag. */
const MINIMUM_MAJOR = 24;

/**
 * Returns a human-readable problem with the current runtime, or null when it is
 * fine. Entry points call this so an unsupported Node produces a sentence rather
 * than a stack trace from deep inside the storage layer.
 */
export function checkRuntime(version = process.versions.node): string | null {
  const major = Number(version.split(".")[0]);
  if (Number.isFinite(major) && major >= MINIMUM_MAJOR) return null;

  return (
    `DevMemory needs Node ${MINIMUM_MAJOR} or newer, but this is Node ${version}.\n` +
    "It stores everything in SQLite through Node's built-in node:sqlite module, which\n" +
    `earlier versions either do not ship or keep behind --experimental-sqlite.\n` +
    "Install Node 24 (the current LTS) and try again: https://nodejs.org"
  );
}

/** Prints the problem and exits, or returns so the caller can carry on. */
export function requireSupportedRuntime(): void {
  const problem = checkRuntime();
  if (!problem) return;
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
