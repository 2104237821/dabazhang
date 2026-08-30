import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CommandAck } from "@dabazhang/protocol";
import { io as createSocketClient } from "socket.io-client";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGameServer,
  registerShutdownSignals,
  type GameServer
} from "./server.js";

const servers: GameServer[] = [];
const sockets: ClientSocket[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const server of servers.splice(0)) await server.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("production HTTP surface", () => {
  it("serves built files and SPA history routes but never turns missing assets into HTML", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "dabazhang-static-"));
    temporaryDirectories.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>打八张</title>");
    await writeFile(join(staticRoot, "app.js"), "globalThis.__DABAZHANG__ = true;");
    const server = createGameServer({ staticRoot });
    servers.push(server);
    await server.app.ready();

    const root = await server.app.inject({ method: "GET", url: "/" });
    const script = await server.app.inject({ method: "GET", url: "/app.js" });
    const history = await server.app.inject({
      headers: { accept: "text/html" },
      method: "GET",
      url: "/room/ABC234"
    });
    const missingAsset = await server.app.inject({
      headers: { accept: "text/html" },
      method: "GET",
      url: "/assets/missing.js"
    });

    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain("__DABAZHANG__");
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain("打八张");
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.headers["content-type"]).toContain("application/json");
    expect(missingAsset.body).not.toContain("打八张");
  });

  it("adds security headers to API and static responses", async () => {
    const server = createGameServer({ enableHsts: true });
    servers.push(server);

    const response = await server.app.inject({ method: "GET", url: "/healthz" });

    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("command admission and shutdown", () => {
  it("rejects an unapproved WebSocket origin and accepts the configured public origin", async () => {
    const server = createGameServer({ allowedOrigin: "https://cards.example.com" });
    servers.push(server);
    const url = await server.listen({ host: "127.0.0.1", port: 0 });
    const rejected = createSocketClient(url, {
      extraHeaders: { origin: "https://attacker.example.com" },
      forceNew: true,
      reconnection: false,
      transports: ["websocket"]
    });
    sockets.push(rejected);

    await expect(once(rejected, "connect_error")).resolves.toBeDefined();

    const allowed = createSocketClient(url, {
      extraHeaders: { origin: "https://cards.example.com" },
      forceNew: true,
      reconnection: false,
      transports: ["websocket"]
    });
    sockets.push(allowed);
    await once(allowed, "connect");
    await expect(command(allowed, "room:create", { nickname: "甲" })).resolves.toMatchObject({
      ok: true
    });
  });

  it("rate limits each socket independently with a bounded command window", async () => {
    const server = createGameServer({ commandRateLimit: { max: 2, windowMs: 60_000 } });
    servers.push(server);
    const url = await server.listen({ host: "127.0.0.1", port: 0 });
    const first = await connect(url);
    const second = await connect(url);

    expect(await command(first, "room:create", { nickname: "甲" })).toMatchObject({ ok: true });
    expect(await command(first, "room:ready", { ready: true })).toMatchObject({ ok: true });
    expect(await command(first, "room:add-bot", {})).toMatchObject({
      error: { code: "RATE_LIMITED" },
      ok: false
    });
    expect(await command(second, "room:create", { nickname: "乙" })).toMatchObject({ ok: true });
  });

  it("becomes unready, notifies clients, and refuses commands before transport close", async () => {
    const server = createGameServer();
    servers.push(server);
    const url = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connect(url);
    const notice = once(socket, "server:shutdown");

    server.beginShutdown("计划维护");

    await expect(notice).resolves.toEqual({ reason: "计划维护", reconnect: false });
    const readiness = await server.app.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({ status: "not-ready", rooms: 0 });
    expect(await command(socket, "room:create", { nickname: "甲" })).toMatchObject({
      error: { code: "SERVER_RESTARTED" },
      ok: false
    });
  });

  it("registers disposable one-shot SIGTERM and SIGINT handlers without leaking listeners", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const dispose = registerShutdownSignals({ close }, signals);

    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    dispose();
    expect(close).toHaveBeenCalledOnce();
  });
});

async function connect(url: string): Promise<ClientSocket> {
  const socket = createSocketClient(url, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"]
  });
  sockets.push(socket);
  await once(socket, "connect");
  return socket;
}

function command(socket: ClientSocket, type: string, payload: unknown): Promise<CommandAck> {
  return new Promise((resolve) => {
    socket.emit(
      "command",
      { payload, requestId: randomUUID(), type },
      (ack: CommandAck) => resolve(ack)
    );
  });
}

function once(socket: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}
