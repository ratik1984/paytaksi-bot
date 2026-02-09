import jwt from 'jsonwebtoken';

export function issueTokenForTelegramUser(tgUser) {
  const payload = {
    tg_id: tgUser.id,
    first_name: tgUser.first_name,
    last_name: tgUser.last_name,
    username: tgUser.username,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });
  return token;
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'missing_token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}
