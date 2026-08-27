import { randomUUID } from "node:crypto";

import type { CommandAck, StateSnapshot } from "@dabazhang/protocol";
import { io as createSocketClient } from "socket.io-client";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGameServer, type GameServer } from "./server.js";

interface TestClient {
  socket: ClientSocket;
  snapshots: StateSnapshot[];
}

describe("game server", () => {
  let server: GameServer;
  let serverUrl: string;
  const clients: TestClient[] = [];
  const startGame = vi.fn();

  beforeEach(async () => {
    startGame.mockReset();
    server = createGameServer({ roomManagerOptions: { startGame } });
    serverUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.socket.disconnect();
    }
    await server.close();
  });

  it("serves health and readiness endpoints", async () => {
    const health = await fetch(`${serverUrl}/healthz`);
    const readiness = await fetch(`${serverUrl}/readyz`);

    await expect(health.json()).resolves.toEqual({ status: "ok" });
    await expect(readiness.json()).resolves.toEqual({ status: "ready", rooms: 0 });
  });

  it("runs the lobby flow and broadcasts seat-redacted snapshots", async () => {
    const host = await connectClient(serverUrl, clients);
    const guest = await connectClient(serverUrl, clients);

    const createAck = await command(host.socket, "room:create", { nickname: "甲" });
    expect(createAck.ok).toBe(true);
    const hostCreated = lastSnapshot(host);
    expect(hostCreated.resumeToken).toBeTypeOf("string");
    expect(hostCreated.room.players[0]).not.toHaveProperty("hand");

    const joinAck = await command(guest.socket, "room:join", {
      roomCode: hostCreated.room.roomCode,
      nickname: "乙"
    });
    expect(joinAck.ok).toBe(true);
    expect(lastSnapshot(guest).resumeToken).toBeTypeOf("string");
    expect(lastSnapshot(host)).not.toHaveProperty("resumeToken");

    const unauthorized = await command(guest.socket, "room:add-bot", {});
    expect(unauthorized).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });

    await command(host.socket, "room:fill-bots", {});
    await command(host.socket, "room:ready", { ready: true });
    const earlyStart = await command(host.socket, "room:start", {});
    expect(earlyStart).toMatchObject({ ok: false, error: { code: "NOT_READY" } });

    await command(guest.socket, "room:ready", { ready: true });
    const guestPlaying = waitForSnapshot(guest.socket, (snapshot) => snapshot.room.status === "playing");
    const startAck = await command(host.socket, "room:start", {});
    expect(startAck.ok).toBe(true);
    expect(startGame).toHaveBeenCalledOnce();
    await guestPlaying;
    expect(lastSnapshot(host).room.status).toBe("playing");
    expect(lastSnapshot(guest).room.status).toBe("playing");
  });

  it("lets a resume token move control to a new connection", async () => {
    const original = await connectClient(serverUrl, clients);
    await command(original.socket, "room:create", { nickname: "甲" });
    const created = lastSnapshot(original);
    const resumeToken = created.resumeToken;
    if (resumeToken === undefined) {
      throw new Error("missing resume token");
    }

    const replacementNotice = once(original.socket, "session:replaced");
    const originalDisconnected = once(original.socket, "disconnect");
    const replacement = await connectClient(serverUrl, clients);
    const resumeAck = await command(replacement.socket, "room:resume", {
      roomCode: created.room.roomCode,
      resumeToken
    });

    expect(resumeAck.ok).toBe(true);
    await expect(replacementNotice).resolves.toEqual({ code: "SESSION_REPLACED" });
    await originalDisconnected;
    expect(original.socket.connected).toBe(false);
    expect(lastSnapshot(replacement).room.selfSeat).toBe(0);
    expect(lastSnapshot(replacement).room.players[0]).toMatchObject({
      online: true,
      controller: "human"
    });
  });

  it("strictly rejects malformed commands", async () => {
    const client = await connectClient(serverUrl, clients);

    const ack = await emitRaw(client.socket, {
      requestId: randomUUID(),
      type: "room:create",
      payload: { nickname: "甲", injected: true }
    });

    expect(ack).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(server.rooms.getRoomCount()).toBe(0);
  });
});

async function connectClient(serverUrl: string, clients: TestClient[]): Promise<TestClient> {
  const socket = createSocketClient(serverUrl, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false
  });
  const client: TestClient = { socket, snapshots: [] };
  clients.push(client);
  socket.on("state:snapshot", (snapshot: StateSnapshot) => {
    client.snapshots.push(snapshot);
  });
  await once(socket, "connect");
  return client;
}

function command(socket: ClientSocket, type: string, payload: unknown): Promise<CommandAck> {
  return emitRaw(socket, { requestId: randomUUID(), type, payload });
}

function emitRaw(socket: ClientSocket, value: unknown): Promise<CommandAck> {
  return new Promise((resolve) => {
    socket.emit("command", value, (ack: CommandAck) => resolve(ack));
  });
}

function once(socket: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once(event, resolve);
  });
}

function lastSnapshot(client: TestClient): StateSnapshot {
  const snapshot = client.snapshots.at(-1);
  if (snapshot === undefined) {
    throw new Error("expected a state snapshot");
  }
  return snapshot;
}

function waitForSnapshot(
  socket: ClientSocket,
  predicate: (snapshot: StateSnapshot) => boolean
): Promise<StateSnapshot> {
  return new Promise((resolve) => {
    const listener = (snapshot: StateSnapshot) => {
      if (predicate(snapshot)) {
        socket.off("state:snapshot", listener);
        resolve(snapshot);
      }
    };
    socket.on("state:snapshot", listener);
  });
}
