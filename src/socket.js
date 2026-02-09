import { verifyInitData } from "./telegramAuth.js";
import { CONFIG } from "./config.js";
import { upsertUserFromTelegram, setAdminRoleByTgId } from "./repo.js";

export function wireSocket(io) {
  io.on("connection", (socket) => {
    // client must immediately emit 'auth' with {initData, role}
    socket.on("auth", ({ initData, role }) => {
      const vr = verifyInitData(initData, CONFIG.BOT_TOKEN);
      if (!vr.ok) return socket.emit("auth_error", { error: vr.error });

      const tgUser = vr.user;
      if (CONFIG.ADMIN_IDS.includes(Number(tgUser.id))) setAdminRoleByTgId(Number(tgUser.id));
      const user = upsertUserFromTelegram({ tgUser, role: role || "passenger" });

      socket.data.user = user;
      socket.data.tgUser = tgUser;

      socket.join(`user:${user.id}`);
      if (user.role === "driver") socket.join("drivers");
      if (user.role === "admin") socket.join("admin");

      socket.emit("auth_ok", { user });

      socket.on("join_ride", ({ ride_id }) => {
        if (!ride_id) return;
        socket.join(`ride:${ride_id}`);
      });

      socket.on("leave_ride", ({ ride_id }) => {
        if (!ride_id) return;
        socket.leave(`ride:${ride_id}`);
      });
    });
  });
}
