import { table, integer, text, primaryKey, index } from 'sdk/db';

export const userState = table('user_state', {
  userId: integer('user_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.key] }),
  keyIdx: index('idx_user_state_key').on(t.key),
}));

export const miniUsers = table('mini_users', {
  userId: integer('user_id').primaryKey(),
  firstName: text('first_name'),
  username: text('username'),
  createdAt: integer('created_at').notNull(),
});
