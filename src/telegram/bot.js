// Lightweight bot wrapper using Telegram Bot API via fetch (no extra deps).
// It supports: setWebhook, sendMessage, answerCallbackQuery, handleUpdate.

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function tg(token, method, body) {
  const res = await fetch(API(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw Object.assign(new Error(data.description || 'telegram_error'), { data });
  return data.result;
}

function parseAdminIds() {
  const raw = process.env.ADMIN_IDS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(Number);
}

export function makeBot({ baseUrl }) {
  const token = process.env.BOT_TOKEN;
  const adminIds = parseAdminIds();

  async function sendStart(chatId) {
    const text = [
      '🚕 *PayTaksi*',
      '',
      'Seçim edin:',
      '• Sərnişin (sifariş ver)',
      '• Sürücü (qeydiyyat / online)',
      '• Admin (nəzarət paneli)',
    ].join('\n');

    const mkWebAppBtn = (label, path) => ({
      text: label,
      web_app: { url: `${baseUrl}${path}` },
    });

    const keyboard = {
      inline_keyboard: [
        [ mkWebAppBtn('🧍 Sərnişin', '/rider') ],
        [ mkWebAppBtn('🚗 Sürücü', '/driver') ],
        ...(adminIds.includes(Number(chatId)) ? [[ mkWebAppBtn('🛠 Admin', '/admin') ]] : []),
      ],
    };

    return tg(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  async function handleUpdate(update) {
    // Commands
    const msg = update.message;
    if (msg?.text) {
      const text = msg.text.trim();
      if (text === '/start' || text.startsWith('/start ')) {
        return sendStart(msg.chat.id);
      }
      if (text === '/help') {
        return tg(token, 'sendMessage', { chat_id: msg.chat.id, text: 'Yalnız /start istifadə edin.' });
      }
    }
    // Callbacks (not used now)
    if (update.callback_query) {
      await tg(token, 'answerCallbackQuery', { callback_query_id: update.callback_query.id });
    }
  }

  return {
    api: {
      setWebhook: (url) => tg(token, 'setWebhook', { url }),
    },
    handleUpdate,
  };
}
