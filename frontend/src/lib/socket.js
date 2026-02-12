import { io } from "socket.io-client";
const BASE = import.meta.env.VITE_API_BASE || "";

let socket = null;

export function getSocket() {
  if (socket) return socket;

  socket = io(BASE, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    timeout: 20000
  });

  return socket;
}
