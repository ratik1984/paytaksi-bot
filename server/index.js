import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

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

const PORT = process.env.PORT || 3000;

async function main() {
  // IMPORTANT:
  // Some hosts (like Render) may start the service without running `prisma generate`.
  // We run it on startup to guarantee @prisma/client is initialized.
  try {
    execSync("npx prisma generate", { stdio: "inherit" });
  } catch (e) {
    console.warn("prisma generate warning:", e?.message || e);
  }

  // Load Prisma and other modules AFTER generate
  const [{ prisma }, { initSettings }, { startPassengerBot }, { startDriverBot }, { startAdminBot }, { adminRouter }] =
    await Promise.all([
      import("./lib/prisma.js"),
      import("./lib/settings.js"),
      import("./bots/passenger.js"),
      import("./bots/driver.js"),
      import("./bots/admin.js"),
      import("./web/admin.js")
    ]);

  // DB migrate (safe to run each start)
  try {
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
  } catch (e) {
    console.warn("migrate deploy warning:", e?.message || e);
  }

  await prisma.$connect();
  await initSettings();

  app.use("/admin", adminRouter);

  startPassengerBot();
  startDriverBot();
  startAdminBot();

  app.listen(PORT, () => console.log(`Web listening on :${PORT}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
