import { db } from 'sdk';
import { miniUsers } from '../schema.js';

export default async function (_input, ctx) {
  const user = ctx.initData?.user;
  if (!user?.id) throw new Error('Telegram user context is missing');
  await db.insert(miniUsers).values({
    userId: user.id,
    firstName: user.first_name || '',
    username: user.username || '',
    createdAt: Math.floor(Date.now() / 1000),
  }).onConflictDoUpdate({
    target: miniUsers.userId,
    set: { firstName: user.first_name || '', username: user.username || '' },
  }).run();
  return { ok: true, user: { id: user.id, first_name: user.first_name || '' } };
}
