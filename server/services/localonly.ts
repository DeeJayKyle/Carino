import type { Db } from '../db/index.ts';

/**
 * Content the user keeps on their own devices: chats marked private, folders and memories marked
 * local-only. Tools hide it from cloud models; when a local model reads it, the chat itself
 * becomes local-only, so later messages (which carry the history) can't take it to the cloud.
 */
export function folderLocalOnly(db: Db, grantId: string): boolean {
  return !!db.get('SELECT local_only FROM folder_grants WHERE id = ?', grantId)?.local_only;
}

export function fileLocalOnly(db: Db, fileId: string): boolean {
  return !!db.get('SELECT g.local_only FROM local_files f JOIN folder_grants g ON g.id = f.grant_id WHERE f.id = ?', fileId)?.local_only;
}

export function chunkLocalOnly(db: Db, chunkId: string): boolean {
  return !!db.get('SELECT g.local_only FROM local_file_chunks c JOIN local_files f ON f.id = c.file_id JOIN folder_grants g ON g.id = f.grant_id WHERE c.id = ?', chunkId)?.local_only;
}

export function memoryLocalOnly(db: Db, memoryId: string): boolean {
  return !!db.get('SELECT local_only FROM memories WHERE id = ?', memoryId)?.local_only;
}

export function markConversationLocalOnly(db: Db, userId: string, conversationId: string | null) {
  // 2 = locked by content (the user's own on/off choice is 1).
  if (conversationId) db.run('UPDATE conversations SET local_only = 2 WHERE id = ? AND user_id = ?', conversationId, userId);
}

export const CLOUD_BLOCKED = 'This is kept on your devices, so it can’t be sent to an online AI. Mark the chat private (🔒) or switch to a local model to use it.';
