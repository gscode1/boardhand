import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Writes `contents` so a reader (or a crash) sees the old file or the new one, never half of one: write a private temp
 * file in the same directory, then rename it over the target.
 */
export async function writeFileAtomic(path: string, contents: string, mode: number): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, contents, { mode });
  // writeFile's mode is masked by the umask, and the claim store's files hold secrets, so set it exactly.
  await chmod(temp, mode);
  await rename(temp, path);
}
