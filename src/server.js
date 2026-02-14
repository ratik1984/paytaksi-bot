import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.APP_BASE_URL || ""; // e.g. https://paytaksi-bot.onrender.com
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "paytaksi";

// Optional (recommended): define up to 3 bot tokens
const TOKENS = {
  passenger: process.env.PASSENGER_BOT_TOKEN || process.env.BOT_TOKEN || "",
  driver: process.env.DRIVER_BOT_TOKEN || "",
  admin: process.env.ADMIN_BOT_TOKEN || "",
};

function roleHasToken(role) {
  return Boolean(TOKENS[role]);
}

function api(role) {
  return `https://api.telegram.org/bot${TOKENS[role]}`;
}

async function sendMessage(role, chat_id, text, extra = {}) {
  if (!roleHasToken(role)) return;
  try {
    await axios.post(`${api(role)}/sendMessage`, { chat_id, text, ...extra });
  } catch (e) {
    console.error("sendMessage error:", e?.response?.data || e.message);
  }
}

async function answerCallback(role, callback_query_id, text = "", show_alert = false) {
  if (!roleHasToken(role)) return;
  try {
    await axios.post(`${api(role)}/answerCallbackQuery`, {
      callback_query_id,
      text,
      show_alert,
    });
  } catch (e) {
    console.error("answerCallback error:", e?.response?.data || e.message);
  }
}

// In-memory active rides (demo). Replace with DB later if needed.
const activeRideByPassenger = new Map(); // passengerChatId -> { rideId, status, driverChatId? }
let rideSeq = 1;

// Health endpoints
app.get("/", (req, res) => res.status(200).send("PayTaksi bot server is live ✅"));
app.get("/webhook", (req, res) => res.status(200).send("Webhook endpoint is OK ✅ (POST only for Telegram)"));

// Webhook routes
function pickRoleFromParams(req) {
  const { secret, role } = req.params || {};
  // /webhook/:role
  if (secret && !role) {
    const maybeRole = secret;
    if (["passenger", "driver", "admin"].includes(maybeRole)) return { role: maybeRole, secret: null };
    return { role: "passenger", secret: secret }; // could be secret without role
  }
  // /webhook/:secret/:role
  if (secret && role) return { role, secret };
  return { role: "passenger", secret: null };
}

function secretOk(secret) {
  if (!secret) return true; // accept if no secret provided
  return String(secret) === String(WEBHOOK_SECRET);
}

app.post("/webhook/:secret/:role", handleWebhook);
app.post("/webhook/:role", handleWebhook);
app.post("/webhook", handleWebhook);

async function handleWebhook(req, res) {
  try {
    const { role, secret } = pickRoleFromParams(req);
    if (!["passenger", "driver", "admin"].includes(role)) return res.status(200).send("OK");
    if (!secretOk(secret)) return res.status(200).send("OK");
    if (!roleHasToken(role)) return res.status(200).send("OK");

    const update = req.body;

    // Callback buttons
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const data = cq.data || "";

      if (role === "passenger" && data.startsWith("cancel_")) {
        const rideId = data.replace("cancel_", "");
        const ride = activeRideByPassenger.get(chatId);
        if (!ride || String(ride.rideId) !== String(rideId)) {
          await answerCallback(role, cq.id, "Bu sifariş artıq aktiv deyil.", true);
        } else {
          activeRideByPassenger.delete(chatId);
          await answerCallback(role, cq.id, "Sifariş ləğv edildi ✅", false);
          await sendMessage("passenger", chatId, `❌ Sifariş #${rideId} ləğv edildi.`);
          if (ride.driverChatId) {
            await sendMessage("driver", ride.driverChatId, `⚠️ Sərnişin sifarişi ləğv etdi. Sifariş #${rideId}`);
          }
        }
      }

      return res.status(200).send("OK");
    }

    // Messages
    const msg = update.message;
    if (!msg || !msg.chat) return res.status(200).send("OK");

    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();

    if (role === "passenger") await handlePassenger(chatId, text);
    if (role === "driver") await handleDriver(chatId, text);
    if (role === "admin") await handleAdmin(chatId, text);

    return res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e.message);
    return res.status(200).send("OK");
  }
}

// Role handlers
async function handlePassenger(chatId, text) {
  if (text === "/start") {
    return sendMessage("passenger", chatId,
`🚕 PayTaksi – Sərnişin botu
Sifariş vermək: /order
Aktiv sifarişi ləğv: /cancel
Yazışma: msg: salam`);
  }

  if (text === "/order" || text.toLowerCase() === "sifariş") {
    const existing = activeRideByPassenger.get(chatId);
    if (existing && ["searching", "accepted", "ongoing"].includes(existing.status)) {
      return sendMessage("passenger", chatId, "❗ Aktiv sifarişiniz var. Əvvəlcə ləğv edin: /cancel");
    }

    const rideId = rideSeq++;
    const ride = { rideId, status: "searching", driverChatId: null };
    activeRideByPassenger.set(chatId, ride);

    await sendMessage("passenger", chatId,
`✅ Sifariş #${rideId} yaradıldı.
Sürücü axtarılır...
Ləğv etmək üçün düyməni basın:`,
{
  reply_markup: {
    inline_keyboard: [[{ text: "Sifarişi ləğv et", callback_data: `cancel_${rideId}` }]]
  }
});

    return;
  }

  if (text === "/cancel" || text.toLowerCase() === "ləğv") {
    const ride = activeRideByPassenger.get(chatId);
    if (!ride) return sendMessage("passenger", chatId, "Aktiv sifariş yoxdur.");
    activeRideByPassenger.delete(chatId);
    await sendMessage("passenger", chatId, `❌ Sifariş #${ride.rideId} ləğv edildi.`);
    if (ride.driverChatId) {
      await sendMessage("driver", ride.driverChatId, `⚠️ Sərnişin sifarişi ləğv etdi. Sifariş #${ride.rideId}`);
    }
    return;
  }

  // Passenger -> Driver chat
  if (text.toLowerCase().startsWith("msg:")) {
    const ride = activeRideByPassenger.get(chatId);
    if (!ride || !ride.driverChatId) {
      return sendMessage("passenger", chatId, "❗ Sürücü qoşulmayıb. Əvvəlcə sürücü sifarişi qəbul etməlidir.");
    }
    const content = text.slice(4).trim();
    if (!content) return;
    await sendMessage("driver", ride.driverChatId, `💬 Sərnişin (#${ride.rideId}): ${content}`);
    return sendMessage("passenger", chatId, "✅ Göndərildi.");
  }

  return sendMessage("passenger", chatId, "Komandalar: /order, /cancel. Yazışma: msg: salam");
}

async function handleDriver(chatId, text) {
  if (text === "/start") {
    return sendMessage("driver", chatId,
`🚖 PayTaksi – Sürücü botu
Sifarişi qəbul: /accept <id>
Yazışma: msg: salam`);
  }

  const m = text.match(/^\/accept\s+(\d+)/i);
  if (m) {
    const rideId = Number(m[1]);
    let passengerId = null;
    for (const [pid, ride] of activeRideByPassenger.entries()) {
      if (ride.rideId === rideId && ride.status === "searching") {
        passengerId = pid;
        ride.status = "accepted";
        ride.driverChatId = chatId;
        break;
      }
    }
    if (!passengerId) {
      return sendMessage("driver", chatId, "❗ Bu sifariş tapılmadı və ya artıq qəbul olunub.");
    }
    await sendMessage("driver", chatId, `✅ Sifariş #${rideId} qəbul edildi.`);
    await sendMessage("passenger", passengerId,
`🚖 Sürücü sifarişi qəbul etdi! (Sifariş #${rideId})
Yazışma üçün: msg: salam`);
    return;
  }

  if (text.toLowerCase().startsWith("msg:")) {
    let targetPassenger = null;
    let rideId = null;
    for (const [pid, ride] of activeRideByPassenger.entries()) {
      if (ride.driverChatId === chatId && ["accepted", "ongoing", "searching"].includes(ride.status)) {
        targetPassenger = pid;
        rideId = ride.rideId;
        break;
      }
    }
    if (!targetPassenger) {
      return sendMessage("driver", chatId, "❗ Aktiv sifariş yoxdur. Əvvəlcə /accept <id>.");
    }
    const content = text.slice(4).trim();
    if (!content) return;
    await sendMessage("passenger", targetPassenger, `💬 Sürücü (#${rideId}): ${content}`);
    return sendMessage("driver", chatId, "✅ Göndərildi.");
  }

  return sendMessage("driver", chatId, "Komandalar: /accept <id>. Yazışma: msg: salam");
}

async function handleAdmin(chatId, text) {
  if (text === "/start") {
    return sendMessage("admin", chatId,
`🛠 PayTaksi – Admin botu
/stats  (aktiv sifariş sayı)`);
  }
  if (text === "/stats") {
    return sendMessage("admin", chatId, `📊 Aktiv sifariş sayı: ${activeRideByPassenger.size}`);
  }
  return sendMessage("admin", chatId, "Komandalar: /stats");
}

// Auto setWebhook on boot (if BASE_URL and tokens exist)
async function trySetWebhooks() {
  if (!BASE_URL) return;
  const secret = encodeURIComponent(WEBHOOK_SECRET);

  const roles = ["passenger", "driver", "admin"];
  const jobs = roles
    .filter((r) => roleHasToken(r))
    .map((r) => {
      const url = `${BASE_URL}/webhook/${secret}/${r}`;
      return axios
        .get(`${api(r)}/setWebhook`, { params: { url } })
        .then(() => console.log(`Webhook set for ${r}: ${url}`))
        .catch((e) => console.error(`setWebhook failed for ${r}:`, e?.response?.data || e.message));
    });

  await Promise.allSettled(jobs);
}

app.listen(PORT, async () => {
  console.log(`PayTaksi server listening on ${PORT}`);
  console.log(`Primary URL: ${BASE_URL || "(not set)"}`);
  console.log(`Webhook secret: ${WEBHOOK_SECRET}`);
  await trySetWebhooks();
});
