import writeFileAtomicImpl from "write-file-atomic";

/**
 * Atomically write data to a file with fsync durability.
 *
 * Thin re-export over the npm `write-file-atomic` library, which writes to
 * `<filePath>.<hash>` first, fsyncs the tmp file, renames into place, and
 * fsyncs the parent directory — so both process crashes AND power loss
 * leave the previous file intact (or, on first write, no file at all)
 * rather than a truncated / half-written one.
 *
 * Callers must pick a destination on the same filesystem as its parent
 * directory — `rename` across filesystems is not atomic. All callers in
 * this repo write under `.sygil/` / `~/.sygil/`, which is always local.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  await writeFileAtomicImpl(filePath, data, { encoding });
}
