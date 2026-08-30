import { randomUUID } from "node:crypto";

import { clientCommandSchema } from "@dabazhang/protocol";
import type { ClientCommand, CommandAck, CommandErrorCode } from "@dabazhang/protocol";
import fastifyStatic from "@fastify/static";
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
const MAX_RECENT_REQUEST_IDS = 4_096;
const DEFAULT_RATE_LIMIT_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 10_000;

interface CommandRateLimitOptions {
  max: number;
  windowMs: number;
}

export interface CreateGameServerOptions {
  logger?: FastifyServerOptions["logger"];
  roomManager?: RoomManager;
  roomManagerOptions?: RoomManagerOptions;
  allowedOrigin?: string | string[];
  commandRateLimit?: CommandRateLimitOptions;
  enableHsts?: boolean;
  staticRoot?: string;
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
  beginShutdown(reason?: string): void;
  close(): Promise<void>;
}

export interface ShutdownSignalEmitter {
  once(eventName: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  removeListener(eventName: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export function createGameServer(options: CreateGameServerOptions = {}): GameServer {
  const app = Fastify({ logger: options.logger ?? false });
  const io = new SocketIoServer(app.server, {
    cors: {
      origin: options.allowedOrigin ?? false,
      credentials: true
    },
    allowRequest: (request, callback) => {
      callback(
        null,
        isRequestOriginAllowed(request.headers.origin, request.headers.host, options.allowedOrigin)
      );
    },
    maxHttpBufferSize: 32 * 1024
  });
  const rooms = options.roomManager ?? new RoomManager(options.roomManagerOptions);
  rooms.setRoomChangedHandler((roomCode) => broadcastRoom(io, rooms, roomCode));
  const instanceId = randomUUID();
  const recentRequestIds = new Map<string, true>();
  const rateLimit = normalizeRateLimit(options.commandRateLimit);
  let acceptingCommands = true;

  app.addHook("onSend", (_request, reply, _payload, done) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:"
    );
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    if (options.enableHsts === true) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    done();
  });

  if (options.staticRoot !== undefined) {
    void app.register(fastifyStatic, {
      root: options.staticRoot,
      index: "index.html",
      redirect: false
    });
  }

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    if (!acceptingCommands) {
      return reply.code(503).send({ status: "not-ready", rooms: rooms.getRoomCount() });
    }
    return { status: "ready", rooms: rooms.getRoomCount() };
  });

  app.setNotFoundHandler((request, reply) => {
    if (options.staticRoot !== undefined && isSpaHistoryRequest(request.method, request.url, request.headers.accept)) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    return reply.code(404).send({ error: "NOT_FOUND", message: "资源不存在" });
  });

  io.on("connection", (socket) => {
    const limiter = createCommandLimiter(rateLimit);
    socket.emit("server:info", { instanceId, persistentRooms: false });
    socket.on("command", (raw: unknown, callback?: CommandAckCallback) => {
      if (!limiter.take()) {
        sendAck(socket, callback, {
          requestId: readRequestId(raw),
          ok: false,
          error: { code: "RATE_LIMITED", message: "操作过于频繁，请稍后再试" }
        });
        return;
      }
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
  const server: GameServer = {
    app,
    io,
    rooms,
    async listen(listenOptions = {}) {
      return app.listen({
        host: listenOptions.host ?? "0.0.0.0",
        port: listenOptions.port ?? 3000
      });
    },
    beginShutdown(reason = "服务器正在维护") {
      if (!acceptingCommands) return;
      acceptingCommands = false;
      rooms.close();
      io.emit("server:shutdown", { reason, reconnect: false });
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      server.beginShutdown();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      if (app.server.listening) {
        await app.close();
      }
    }
  };
  return server;

  async function handleCommand(
    socket: Socket,
    raw: unknown,
    callback?: CommandAckCallback
  ): Promise<void> {
    const requestId = readRequestId(raw);
    if (!acceptingCommands) {
      sendAck(socket, callback, {
        requestId,
        ok: false,
        error: { code: "SERVER_RESTARTED", message: "服务器正在关闭" }
      });
      return;
    }
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success) {
      sendAck(socket, callback, {
        requestId,
        ok: false,
        error: { code: "BAD_REQUEST", message: "请求格式无效" }
      });
      return;
    }

    if (recentRequestIds.has(parsed.data.requestId)) {
      sendAck(socket, callback, {
        requestId: parsed.data.requestId,
        ok: false,
        error: { code: "DUPLICATE_REQUEST", message: "该请求已经处理过" }
      });
      return;
    }
    rememberRequestId(recentRequestIds, parsed.data.requestId);

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
      case "game:pass-attack":
      case "game:defend":
      case "game:take":
      case "game:stop-attack":
      case "game:assist-propose":
      case "game:assist-decide":
      case "game:exchange-trump-two":
      case "game:decline-trump-two":
        return rooms.executeGameCommand(socketId, command);
      case "match:play-again":
        return rooms.playAgain(socketId);
    }
  }
}

export function registerShutdownSignals(
  server: Pick<GameServer, "close">,
  emitter: ShutdownSignalEmitter = process
): () => void {
  let disposed = false;
  let closing = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    emitter.removeListener("SIGTERM", handleSignal);
    emitter.removeListener("SIGINT", handleSignal);
  };
  const handleSignal = () => {
    if (closing) return;
    closing = true;
    dispose();
    void server.close();
  };
  emitter.once("SIGTERM", handleSignal);
  emitter.once("SIGINT", handleSignal);
  return dispose;
}

function normalizeRateLimit(options: CommandRateLimitOptions | undefined): CommandRateLimitOptions {
  const max = options?.max ?? DEFAULT_RATE_LIMIT_MAX;
  const windowMs = options?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("command rate limit max must be positive");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("command rate limit window must be positive");
  }
  return { max, windowMs };
}

function createCommandLimiter(options: CommandRateLimitOptions): { take(): boolean } {
  let windowStartedAt = Date.now();
  let used = 0;
  return {
    take() {
      const now = Date.now();
      if (now - windowStartedAt >= options.windowMs || now < windowStartedAt) {
        windowStartedAt = now;
        used = 0;
      }
      if (used >= options.max) return false;
      used += 1;
      return true;
    }
  };
}

function isSpaHistoryRequest(method: string, url: string, accept: string | undefined): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!accept?.split(",").some((value) => value.trim().startsWith("text/html"))) return false;
  const path = url.split("?", 1)[0] ?? url;
  if (path.startsWith("/assets/") || path.startsWith("/socket.io/")) return false;
  const finalSegment = path.slice(path.lastIndexOf("/") + 1);
  return !finalSegment.includes(".");
}

function isRequestOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigin: string | string[] | undefined
): boolean {
  if (origin === undefined) return true;
  if (allowedOrigin !== undefined) {
    const allowed = Array.isArray(allowedOrigin) ? allowedOrigin : [allowedOrigin];
    return allowed.includes(origin);
  }
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function rememberRequestId(requestIds: Map<string, true>, requestId: string): void {
  requestIds.set(requestId, true);
  if (requestIds.size <= MAX_RECENT_REQUEST_IDS) return;
  const oldest = requestIds.keys().next().value;
  if (oldest !== undefined) requestIds.delete(oldest);
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
