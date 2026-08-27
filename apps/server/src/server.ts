import { randomUUID } from "node:crypto";

import { clientCommandSchema } from "@dabazhang/protocol";
import type { ClientCommand, CommandAck, CommandErrorCode } from "@dabazhang/protocol";
import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { Server as SocketIoServer } from "socket.io";
import type { Socket } from "socket.io";

import {
  RoomCommandError,
  RoomManager,
  type RoomManagerOptions,
  type RoomMutationResult
} from "./room-manager.js";

type CommandAckCallback = (ack: CommandAck) => void;

export interface CreateGameServerOptions {
  logger?: FastifyServerOptions["logger"];
  roomManager?: RoomManager;
  roomManagerOptions?: RoomManagerOptions;
  allowedOrigin?: string | string[];
}

export interface ListenOptions {
  host?: string;
  port?: number;
}

export interface GameServer {
  app: FastifyInstance;
  io: SocketIoServer;
  rooms: RoomManager;
  listen(options?: ListenOptions): Promise<string>;
  close(): Promise<void>;
}

export function createGameServer(options: CreateGameServerOptions = {}): GameServer {
  const app = Fastify({ logger: options.logger ?? false });
  const io = new SocketIoServer(app.server, {
    cors: {
      origin: options.allowedOrigin ?? true,
      credentials: true
    },
    maxHttpBufferSize: 32 * 1024
  });
  const rooms = options.roomManager ?? new RoomManager(options.roomManagerOptions);

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready", rooms: rooms.getRoomCount() }));

  io.on("connection", (socket) => {
    socket.on("command", (raw: unknown, callback?: CommandAckCallback) => {
      void handleCommand(socket, raw, callback);
    });

    socket.on("disconnect", () => {
      void rooms.disconnect(socket.id).then((result) => {
        if (result !== undefined) {
          broadcastRoom(io, rooms, result.roomCode);
        }
      });
    });
  });

  let closed = false;
  return {
    app,
    io,
    rooms,
    async listen(listenOptions = {}) {
      return app.listen({
        host: listenOptions.host ?? "0.0.0.0",
        port: listenOptions.port ?? 3000
      });
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      if (app.server.listening) {
        await app.close();
      }
    }
  };

  async function handleCommand(
    socket: Socket,
    raw: unknown,
    callback?: CommandAckCallback
  ): Promise<void> {
    const requestId = readRequestId(raw);
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success) {
      sendAck(socket, callback, {
        requestId,
        ok: false,
        error: { code: "BAD_REQUEST", message: "请求格式无效" }
      });
      return;
    }

    try {
      const result = await executeCommand(socket.id, parsed.data);
      if (result.replacedSocketId !== undefined) {
        const replacedSocket = io.sockets.sockets.get(result.replacedSocketId);
        replacedSocket?.emit("session:replaced", { code: "SESSION_REPLACED" });
        replacedSocket?.disconnect(true);
      }
      broadcastRoom(io, rooms, result.roomCode, socket.id, result.resumeToken);
      sendAck(socket, callback, {
        requestId: parsed.data.requestId,
        ok: true,
        ...(result.revision === undefined ? {} : { revision: result.revision })
      });
    } catch (error) {
      const normalized = normalizeCommandError(error);
      sendAck(socket, callback, {
        requestId: parsed.data.requestId,
        ok: false,
        error: normalized
      });
    }
  }

  async function executeCommand(socketId: string, command: ClientCommand): Promise<RoomMutationResult> {
    switch (command.type) {
      case "room:create":
        return rooms.createRoom(socketId, command.payload.nickname);
      case "room:join":
        return rooms.joinRoom(socketId, command.payload.roomCode, command.payload.nickname);
      case "room:resume":
        return rooms.resumeRoom(socketId, command.payload.roomCode, command.payload.resumeToken);
      case "room:ready":
        return rooms.setReady(socketId, command.payload.ready);
      case "room:add-bot":
        return rooms.addBot(socketId);
      case "room:remove-bot":
        return rooms.removeBot(socketId, command.payload.seatId);
      case "room:fill-bots":
        return rooms.fillBots(socketId);
      case "room:start":
        return rooms.startRoom(socketId);
      case "room:leave":
        return rooms.leaveRoom(socketId);
      case "game:attack":
      case "game:defend":
      case "game:take":
      case "game:stop-attack":
      case "game:assist-propose":
      case "game:assist-decide":
      case "game:exchange-trump-two":
      case "game:decline-trump-two":
      case "match:play-again":
        throw new RoomCommandError("ILLEGAL_ACTION", "游戏规则引擎尚未接入");
    }
  }
}

function broadcastRoom(
  io: SocketIoServer,
  rooms: RoomManager,
  roomCode: string,
  tokenSocketId?: string,
  resumeToken?: string
): void {
  for (const delivery of rooms.getConnectedSnapshots(roomCode)) {
    const snapshot =
      delivery.socketId === tokenSocketId && resumeToken !== undefined
        ? rooms.getSnapshotForSocket(delivery.socketId, resumeToken)
        : delivery.snapshot;
    io.to(delivery.socketId).emit("state:snapshot", snapshot);
  }
}

function sendAck(socket: Socket, callback: CommandAckCallback | undefined, ack: CommandAck): void {
  if (callback !== undefined) {
    callback(ack);
    return;
  }
  socket.emit("command:ack", ack);
}

function readRequestId(raw: unknown): string {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "requestId" in raw &&
    typeof raw.requestId === "string"
  ) {
    return raw.requestId;
  }
  return randomUUID();
}

function normalizeCommandError(error: unknown): { code: CommandErrorCode; message: string } {
  if (error instanceof RoomCommandError) {
    return { code: error.code, message: error.message };
  }
  return { code: "BAD_REQUEST", message: "服务器暂时无法处理该请求" };
}
