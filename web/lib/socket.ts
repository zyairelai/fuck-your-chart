import { io, Socket } from "socket.io-client";

let sharedSocket: Socket | null = null;

export function getSharedSocket(): Socket {
  if (!sharedSocket && typeof window !== "undefined") {
    sharedSocket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      timeout: 10000,
    });
  }
  return sharedSocket!;
}

