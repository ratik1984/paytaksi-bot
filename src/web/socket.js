import jwt from 'jsonwebtoken';

export function attachSocket(io, db) {
  // expose io for REST routes
  db.io = io;

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('missing_token'));
      const user = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = user;
      next();
    } catch (e) {
      next(new Error('invalid_token'));
    }
  });

  io.on('connection', async (socket) => {
    const tg = socket.user;
    // map telegram user -> db user id
    const q = await db.query('SELECT id FROM users WHERE tg_id=$1', [tg.tg_id]);
    let userId = q.rows[0]?.id;
    if (!userId) {
      const ins = await db.query(
        `INSERT INTO users (tg_id, first_name, last_name, username) VALUES ($1,$2,$3,$4) RETURNING id`,
        [tg.tg_id, tg.first_name || null, tg.last_name || null, tg.username || null]
      );
      userId = ins.rows[0].id;
    }

    socket.join(`user:${userId}`);

    socket.on('disconnect', () => {});
  });

  // Make io available on app locals via db wrapper when needed
  // (assigned in index.js as req.app.locals.io)
  return io;
}
