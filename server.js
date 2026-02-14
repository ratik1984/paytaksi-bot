import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "paytaksi";
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const PORT = process.env.PORT || 10000;

let activeRides = {}; // user_id -> ride

// ✅ Root test
app.get("/", (req, res) => {
  res.send("PayTaksi bot işləyir 🚕");
});

// ✅ Webhook endpoint
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    if (!update.message) {
      return res.sendStatus(200);
    }

    const chatId = update.message.chat.id;
    const text = update.message.text;

    if (text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "🚕 PayTaksi-ya xoş gəldiniz!\nSifariş üçün 'sifariş' yazın."
      });
    }

    else if (text === "sifariş") {

      if (activeRides[chatId]) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❗ Aktiv sifarişiniz var. Əvvəlcə onu ləğv edin."
        });
      } else {
        activeRides[chatId] = { status: "searching" };

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "🚖 Sifariş yaradıldı.\nLəğv etmək üçün 'ləğv' yazın."
        });
      }
    }

    else if (text === "ləğv") {

      if (!activeRides[chatId]) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "Aktiv sifariş yoxdur."
        });
      } else {
        delete activeRides[chatId];

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Sifariş ləğv edildi."
        });
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

// Start server
app.listen(PORT, () => {
  console.log("Server başladı:", PORT);
});
