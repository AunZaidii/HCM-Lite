import { db } from './db.js';

export async function notify(userIds, { type, title, body = null, link = null }, q = db) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await q.query(
    `insert into notifications (user_id, type, title, body, link)
     select unnest($1::uuid[]), $2, $3, $4, $5`,
    [ids, type, title, body, link],
  );
}

export async function activeUserIds(roles, q = db) {
  const rows = await q.query('select id from users where is_active and role = any($1)', [roles]);
  return rows.map((r) => r.id);
}
