const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function tg(method, body) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then(r => r.json());
}

app.get("/", (req, res) => {
  res.send("PayTaksi bot is running 🚕");
});

app.post(`/tg/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text;

      if (text === "/start") {
        await tg("sendMessage", {
          chat_id: chatId,
          text:
            "🚕 *PayTaksi*\n\n" +
            "Xoş gəldin!\n\n" +
            "Aşağıdan seçim et:",
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [
              [{ text: "🚕 Taksi çağır" }],
              [{ text: "🚖 Sürücü paneli" }]
            ],
            resize_keyboard: true
          }
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
