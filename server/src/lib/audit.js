import { db } from './db.js';

const strip = (obj) => {
  if (!obj) return null;
  const { passwordHash, password_hash, ...rest } = obj;
  return rest;
};

// Writes one append-only audit row. Pass `q` to run inside a transaction.
export async function audit({ actor, action, entityType, entityId, before, after, req, q = db }) {
  await q.query(
    `insert into audit_logs (actor_user_id, actor_role, actor_name, action, entity_type, entity_id, before, after, ip, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      actor?.id ?? null, actor?.role ?? null, actor?.fullName ?? null, action, entityType,
      entityId ? String(entityId) : null,
      before ? JSON.stringify(strip(before)) : null,
      after ? JSON.stringify(strip(after)) : null,
      req?.ip ?? null, req?.get?.('user-agent') ?? null,
    ],
  );
}
