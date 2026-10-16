import fs from "node:fs/promises";

/**
 * Bounded, size-based log rotation helpers shared by the local activity JSONL
 * and by the LaunchAgent stdout/stderr runner.
 *
 * Design constraints:
 * - no external dependencies, no compression, no timestamps in names;
 * - rotation is a plain rename shift (base -> base.1, base.1 -> base.2, ...);
 *   the oldest segment is removed, so total on-disk size stays bounded;
 * - every helper tolerates a missing file (ENOENT) and never creates anything
 *   when there is nothing to do;
 * - failures are surfaced to the caller as errors: callers decide whether a
 *   failed rotation must never break the surrounding work.
 *
 * Concurrency: rotation is rename-based and therefore assumes ONE writer per
 * file family. Two writers appending to the same path would race the shift and
 * could duplicate or orphan a generation, so a second writer must use a
 * different path (or serialize through the same process). Callers that must be
 * concurrency-safe (the bridge activity log, the LaunchAgent log runner) hold
 * the only writer and serialize their own appends.
 */

export function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum
    ? Math.floor(parsed)
    : fallback;
}

/** Segment paths for a base file, oldest first: base.N, ..., base.1, base. */
export function segmentPaths(filePath, backups) {
  const count = positiveInteger(backups, 0, 0);
  const paths = [];
  for (let index = count; index >= 1; index -= 1) {
    paths.push(filePath + "." + index);
  }
  paths.push(filePath);
  return paths;
}

export async function fileSize(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? stats.size : 0;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * Shift one generation of segments without any size check:
 * base.N is dropped, base.k -> base.k+1, base -> base.1.
 * The caller owns the decision to rotate.
 */
export async function shiftSegments(filePath, backups) {
  const count = positiveInteger(backups, 0, 0);
  if (!count) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.rm(filePath + "." + count, { force: true });
  for (let index = count - 1; index >= 1; index -= 1) {
    await fs.rename(filePath + "." + index, filePath + "." + (index + 1)).catch(
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      },
    );
  }
  await fs.rename(filePath, filePath + ".1").catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

/**
 * Rotate `filePath` when it reached `maxBytes`.
 * Returns { rotated, sizeBytes } where sizeBytes is the size observed before
 * any rotation.
 */
export async function rotateIfNeeded(filePath, { maxBytes, backups } = {}) {
  const limit = positiveInteger(maxBytes, 0, 0);
  const count = positiveInteger(backups, 0, 0);
  const sizeBytes = await fileSize(filePath);

  if (!limit || sizeBytes < limit) return { rotated: false, sizeBytes };
  if (!count) {
    // No backups requested: truncating is the only bounded option left.
    await fs.writeFile(filePath, "", { mode: 0o600 });
    return { rotated: true, sizeBytes };
  }

  await shiftSegments(filePath, count);
  return { rotated: true, sizeBytes };
}

/**
 * Read a rotated file family newest-first under a byte budget, then return the
 * concatenation in chronological order (oldest segment first).
 * `truncated` is true when older bytes were dropped to honour `maxBytes`.
 */
export async function readSegments(filePath, { backups, maxBytes } = {}) {
  const budget = positiveInteger(maxBytes, 0, 0);
  const paths = segmentPaths(filePath, backups);
  const chunks = [];
  let used = 0;
  let truncated = false;
  let missing = 0;

  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const current = paths[index];
    let raw;
    try {
      raw = await fs.readFile(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        missing += 1;
        continue;
      }
      throw error;
    }
    if (!budget) {
      chunks.push(raw);
      used += raw.length;
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (raw.length > remaining) {
      chunks.push(raw.subarray(raw.length - remaining));
      used = budget;
      truncated = true;
      break;
    }
    chunks.push(raw);
    used += raw.length;
  }

  chunks.reverse();
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes: used,
    truncated,
    segmentsRead: paths.length - missing,
  };
}
