function registerSocket(io, { pool, bots }) {
  io.on('connection', (socket) => {
    socket.on('join', ({ role, tg_id }) => {
      if (!role || !tg_id) return;
      socket.join(`${role}:${tg_id}`);
    });

    socket.on('join_ride', ({ ride_id }) => {
      if (!ride_id) return;
      socket.join(`ride:${ride_id}`);
    });

    socket.on('disconnect', () => {});
  });
}

module.exports = { registerSocket };
