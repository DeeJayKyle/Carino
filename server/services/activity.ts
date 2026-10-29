import type { Db } from '../db/index.ts';

export function logActivity(
  db: Db,
  userId: string,
  a: { entity: string; entityId?: string | null; verb: string; summary: string; projectId?: string | null },
) {
  db.insert('activity', {
    user_id: userId,
    entity: a.entity,
    entity_id: a.entityId ?? null,
    verb: a.verb,
    summary: a.summary.slice(0, 300),
    project_id: a.projectId ?? null,
  });
}

export function notify(db: Db, userId: string, n: { kind: string; title: string; body?: string; link?: string }) {
  return db.insert('notifications', { user_id: userId, kind: n.kind, title: n.title.slice(0, 200), body: (n.body ?? '').slice(0, 1000), link: n.link ?? null });
}
