import { io } from "socket.io-client";
import { API_URL } from "./api";

export function makeSocket() {
  return io(API_URL, { transports: ["websocket"] });
}
