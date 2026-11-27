import { table, integer, text } from 'sdk/db';

export const miniUsers = table('mini_users', {
  userId: integer('user_id').primaryKey(),
  firstName: text('first_name'),
  username: text('username'),
  createdAt: integer('created_at').notNull(),
});
