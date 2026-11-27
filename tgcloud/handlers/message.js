import { api } from 'sdk';

export default async function (message) {
  if (!message?.chat?.id) return;
  const text = 'برای مدیریت هشدارهای قیمت، Mini App را از دکمه زیر باز کن.';
  await api.sendMessage({
    chat_id: message.chat.id,
    text,
    reply_markup: {
      inline_keyboard: [[{
        text: 'باز کردن پنل هشدار قیمت',
        web_app: { url: 'https://app' + (globalThis.APP_ID || '') + '.tgcloud.ai/' }
      }]]
    }
  });
}
