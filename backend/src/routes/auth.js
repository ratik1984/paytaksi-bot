import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signUser } from "../lib/auth.js";

const router = Router();

/**
 * Telegram Mini App auth (relaxed):
 * frontend sends { user: { id, first_name, last_name, username } , role }
 * In production you should validate initData with bot token. For MVP v2 we allow relaxed mode.
 */
router.post("/telegram", async (req, res) => {
  const body = z.object({
    user: z.object({
      id: z.union([z.string(), z.number()]),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      username: z.string().optional()
    }),
    role: z.enum(["PASSENGER","DRIVER"]).optional()
  }).parse(req.body);

  const telegramId = String(body.user.id);
  const name = [body.user.first_name, body.user.last_name].filter(Boolean).join(" ") || null;
  const username = body.user.username || null;

  const existing = await prisma.user.findUnique({ where: { telegramId } });
  const role = body.role || (existing?.role ?? "PASSENGER");

  const user = existing
    ? await prisma.user.update({
        where: { telegramId },
        data: { name, username, role }
      })
    : await prisma.user.create({
        data: { telegramId, name, username, role }
      });

  const token = signUser(user);
  res.json({ token, user: { id: user.id, role: user.role, name: user.name, username: user.username } });
});

router.get("/me", async (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    // verify in auth middleware? keep simple:
    const jwt = (await import("jsonwebtoken")).default;
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev_secret_change_me");
    const user = await prisma.user.findUnique({ where: { id: decoded.uid } });
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ user: { id: user.id, role: user.role, name: user.name, username: user.username } });
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
});

export default router;
