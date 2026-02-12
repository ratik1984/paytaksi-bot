import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

import { prisma } from "./lib/prisma.js";
import { initSettings } from "./lib/settings.js";
import { startPassengerBot } from "./bots/passenger.js";
import { startDriverBot } from "./bots/driver.js";
import { startAdminBot } from "./bots/admin.js";
import { adminRouter } from "./web/admin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET || "dev_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));

app.get("/", (req, res) => res.send("PayTaksi is running. Admin panel: /admin"));
app.use("/admin", adminRouter);

const PORT = process.env.PORT || 3000;

async function main() {
  // DB migrate (Render build does it too, keep safe)
  try { execSync("npx prisma migrate deploy", { stdio: "inherit" }); }
  catch (e) { console.warn("migrate deploy warning:", e?.message || e); }

  await prisma.$connect();
  await initSettings();

  startPassengerBot();
  startDriverBot();
  startAdminBot();

  app.listen(PORT, () => console.log(`Web listening on :${PORT}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
