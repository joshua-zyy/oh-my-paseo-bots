import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 同目录临时文件、fsync、rename；沿用既有 Bot 存档的原子写语义。 */
export async function writeJsonFile(target: string, document: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
