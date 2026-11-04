import { invoke } from '@tauri-apps/api/core';

/** Ordered writes survive editor unmounts; different projects remain independent. */
export class ProjectSaveQueue {
  private pending = new Map<string, Promise<void>>();
  write(projectId: string, save: () => Promise<void>): Promise<void> {
    const write = (this.pending.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(save);
    this.pending.set(projectId, write);
    void write.finally(() => { if (this.pending.get(projectId) === write) this.pending.delete(projectId); }).catch(() => undefined);
    return write;
  }
  async settled(projectId: string): Promise<void> { await this.pending.get(projectId)?.catch(() => undefined); }
}
const queue = new ProjectSaveQueue();
export function saveEdits(projectId: string, data: string): Promise<void> {
  return queue.write(projectId, () => invoke<void>('save_edits', { projectId, data }));
}
export async function loadEdits(projectId: string): Promise<string | null> {
  await queue.settled(projectId);
  return invoke<string | null>('load_edits', { projectId });
}
