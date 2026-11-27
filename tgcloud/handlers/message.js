import { api } from 'sdk';
import { MINI_APP_URL } from '../lib/config.js';

export default async function (message) {
  if (!message?.chat?.id) return;
  await api.sendMessage({
    chat_id: message.chat.id,
    text: 'برای مدیریت هشدارهای قیمت، پنل را از دکمه زیر باز کن.',
    reply_markup: {
      inline_keyboard: [[{
        text: 'باز کردن پنل هشدار قیمت',
        web_app: { url: MINI_APP_URL }
      }]]
    }
  });
}
