const jwt = require('jsonwebtoken');

function signToken(payload, expiresIn = '30d') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function authMiddleware(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (role && decoded.role !== role) return res.status(403).json({ error: 'Forbidden' });
      req.user = decoded;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

module.exports = { signToken, authMiddleware };
