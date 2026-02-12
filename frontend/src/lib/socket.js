import { io } from "socket.io-client";
const BASE = import.meta.env.VITE_API_BASE || "";

let socket = null;

export function getSocket() {
  if (socket) return socket;
  socket = io(BASE, { transports: ["websocket","polling"] });
  return socket;
}
