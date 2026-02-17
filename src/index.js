require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const path = require("path");

const { prisma } = require("./db");
const { ensureAdminSeedFromEnv } = require("./web/adminAuth");
const { adminRouter } = require("./web/adminRoutes");

const { createPassengerBot } = require("./bots/passengerBot");
const { createDriverBot } = require("./bots/driverBot");
const { createAdminBot } = require("./bots/adminBot");
const onlineDrivers = require("./registry/onlineDrivers");

async function main(){
  await ensureAdminSeedFromEnv(process.env);

  const app = express();
  app.use(helmet({ contentSecurityPolicy:false }));
  app.use(bodyParser.urlencoded({ extended:true }));
  app.use(bodyParser.json());
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60*1000, max: 300 }));

  // EJS setup
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "web/views"));
  const ejsMate = require("ejs-mate");
  app.engine("ejs", ejsMate);

  app.get("/", (req,res)=> res.send("PayTaksi MVP is running. Admin: /admin"));

  app.use("/admin", adminRouter);

  const port = process.env.PORT || 3000;
  app.listen(port, ()=> console.log("Web listening on", port));

  // Telegram bots
  const passengerToken = process.env.PASSENGER_BOT_TOKEN;
  const driverToken = process.env.DRIVER_BOT_TOKEN;
  const adminToken = process.env.ADMIN_BOT_TOKEN;

  if (!passengerToken || !driverToken || !adminToken){
    console.log("⚠️ Bot tokens missing. Set PASSENGER_BOT_TOKEN / DRIVER_BOT_TOKEN / ADMIN_BOT_TOKEN in .env");
  }

  // Admin bot used also for notifications
  const adminBot = createAdminBot(adminToken);

  async function adminNotify(text){
    try{
      // send to all admin telegram users
      const admins = await prisma.user.findMany({ where:{ role:"ADMIN" }});
      for (const a of admins){
        if (a.telegramId !== "0") await adminBot.telegram.sendMessage(a.telegramId, text);
      }
    }catch(e){ console.error("adminNotify error", e); }
  }

  async function notifyDrivers(rideId){
    const ride = await prisma.ride.findUnique({ where:{ id: rideId }});
    if (!ride) return;
    const online = onlineDrivers.listOnline();
    if (!online.length) return;

    for (const tgId of online){
      // confirm driver is approved & not blocked
      const driver = await prisma.user.findUnique({ where:{ telegramId: tgId }, include:{ driverProfile:true }});
      if (!driver?.driverProfile || driver.driverProfile.status !== "APPROVED") continue;

      // balance check
      const agg = await prisma.balanceLedger.aggregate({ where:{ userId: driver.id }, _sum:{ amountAzN:true }});
      const bal = Number(agg._sum.amountAzN || 0);
      if (bal <= -15) continue;

      const text = `🚕 Yeni sifariş!
Ride ID: ${ride.id}
Pickup: (${ride.pickupLat.toFixed(5)}, ${ride.pickupLng.toFixed(5)})
Drop: (${ride.dropLat.toFixed(5)}, ${ride.dropLng.toFixed(5)})`;
      const kb = require("telegraf").Markup.inlineKeyboard([
        require("telegraf").Markup.button.callback("✅ Qəbul et", `ACCEPT_${ride.id}`),
      ]);
      try{
        // send via DRIVER bot
        driverBot.telegram.sendMessage(tgId, text, kb);
      }catch(e){}
    }
  }

  const passengerBot = createPassengerBot(passengerToken, notifyDrivers);
  const driverBot = createDriverBot(driverToken, onlineDrivers, adminNotify);

  // Start bots
  if (adminToken) adminBot.launch();
  if (passengerToken) passengerBot.launch();
  if (driverToken) driverBot.launch();

  console.log("Bots launched.");

  process.once("SIGINT", () => { passengerBot.stop("SIGINT"); driverBot.stop("SIGINT"); adminBot.stop("SIGINT"); process.exit(0); });
  process.once("SIGTERM", () => { passengerBot.stop("SIGTERM"); driverBot.stop("SIGTERM"); adminBot.stop("SIGTERM"); process.exit(0); });
}

main().catch(e=>{ console.error(e); process.exit(1); });
