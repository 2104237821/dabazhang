import { randomUUID } from "node:crypto";

import type { CommandAck, StateSnapshot } from "@dabazhang/protocol";
import { io as createSocketClient } from "socket.io-client";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGameServer, type GameServer } from "./server.js";

interface TestClient {
  socket: ClientSocket;
  snapshots: StateSnapshot[];
  serverInfo?: { instanceId: string; persistentRooms: boolean };
}

describe("game server", () => {
  let server: GameServer;
  let serverUrl: string;
  const clients: TestClient[] = [];
  const startGame = vi.fn();

  beforeEach(async () => {
    startGame.mockReset();
    server = createGameServer({ roomManagerOptions: { startGame, rng: () => 0 } });
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

  it("identifies the ephemeral server instance and reports a lost room after restart", async () => {
    const client = await connectClient(serverUrl, clients);
    expect(client.serverInfo).toMatchObject({ persistentRooms: false });
    expect(client.serverInfo?.instanceId).toMatch(/^[0-9a-f-]{36}$/);

    const resume = await command(client.socket, "room:resume", {
      roomCode: "ABC234",
      resumeToken: "x".repeat(32)
    });
    expect(resume).toMatchObject({ ok: false, error: { code: "SERVER_RESTARTED" } });
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

  it("starts an authoritative game, redacts every other hand, and accepts a legal action", async () => {
    const host = await connectClient(serverUrl, clients);
    const guest = await connectClient(serverUrl, clients);
    await command(host.socket, "room:create", { nickname: "甲" });
    const roomCode = lastSnapshot(host).room.roomCode;
    await command(guest.socket, "room:join", { roomCode, nickname: "乙" });
    await command(host.socket, "room:fill-bots", {});
    await command(host.socket, "room:ready", { ready: true });
    await command(guest.socket, "room:ready", { ready: true });
    const hostStarted = waitForSnapshot(host.socket, (snapshot) => snapshot.game !== undefined);
    const guestStarted = waitForSnapshot(guest.socket, (snapshot) => snapshot.game !== undefined);
    await command(host.socket, "room:start", {});
    await Promise.all([hostStarted, guestStarted]);

    const hostGame = lastSnapshot(host).game;
    const guestGame = lastSnapshot(guest).game;
    if (hostGame === undefined || guestGame === undefined) throw new Error("missing game view");
    expect(hostGame.drawPileCount).toBe(22);
    expect(hostGame.players.find((player) => player.seatId === 0)?.hand).toHaveLength(8);
    expect(hostGame.players.filter((player) => player.seatId !== 0).every((player) => player.hand === undefined)).toBe(true);
    expect(guestGame.players.find((player) => player.seatId === 1)?.hand).toHaveLength(8);
    expect(guestGame.players.filter((player) => player.seatId !== 1).every((player) => player.hand === undefined)).toBe(true);
    expect(hostGame).not.toHaveProperty("drawPile");
    expect(hostGame).not.toHaveProperty("cardsById");

    const attack = hostGame.legalActions.find((action) => action.type === "game:attack");
    const cardId = attack?.cardIds?.[0];
    if (cardId === undefined) throw new Error("expected an opening attack");
    const actionSnapshot = waitForSnapshot(host.socket, (snapshot) => snapshot.game?.table.length === 1);
    const actionAck = await command(
      host.socket,
      "game:attack",
      { cardId },
      lastSnapshot(host).revision
    );
    expect(actionAck.ok).toBe(true);
    await actionSnapshot;
    expect(lastSnapshot(host).game).toMatchObject({
      phase: "await-defense",
      table: [{ attack: { cardId } }]
    });
    expect(lastSnapshot(host).game?.players.find((player) => player.seatId === 0)?.hand).toHaveLength(7);
  });

  it("builds four independent human views without leaking another seat's hand", async () => {
    const players = await Promise.all([
      connectClient(serverUrl, clients),
      connectClient(serverUrl, clients),
      connectClient(serverUrl, clients),
      connectClient(serverUrl, clients)
    ]);
    const host = players[0];
    if (host === undefined) throw new Error("missing host");
    await command(host.socket, "room:create", { nickname: "玩家0" });
    const roomCode = lastSnapshot(host).room.roomCode;
    for (const seatId of [1, 2, 3] as const) {
      const player = players[seatId];
      if (player === undefined) throw new Error(`missing player ${seatId}`);
      await command(player.socket, "room:join", { roomCode, nickname: `玩家${seatId}` });
    }
    for (const player of players) await command(player.socket, "room:ready", { ready: true });
    const started = players.map((player) => waitForSnapshot(player.socket, (value) => value.game !== undefined));
    await command(host.socket, "room:start", {});
    await Promise.all(started);

    for (const player of players) {
      const snapshot = lastSnapshot(player);
      const selfSeat = snapshot.room.selfSeat;
      expect(snapshot.game?.players.find((seat) => seat.seatId === selfSeat)?.hand).toHaveLength(8);
      expect(
        snapshot.game?.players
          .filter((seat) => seat.seatId !== selfSeat)
          .every((seat) => seat.hand === undefined)
      ).toBe(true);
    }

    const hostAttack = waitForSnapshots(players, (value) => value.game?.phase === "await-defense");
    await command(host.socket, "game:attack", { cardId: "heart-3" }, lastSnapshot(host).revision);
    await hostAttack;
    const defender = players[1];
    if (defender === undefined) throw new Error("missing defender");
    const attackId = lastSnapshot(defender).game?.table[0]?.attackId;
    if (attackId === undefined) throw new Error("missing attack id");
    const defended = waitForSnapshots(players, (value) => value.game?.phase === "await-continuation");
    await command(
      defender.socket,
      "game:defend",
      { attackId, cardId: "heart-4" },
      lastSnapshot(defender).revision
    );
    await defended;
    const assister = players[2];
    if (assister === undefined) throw new Error("missing assister");
    const proposed = waitForSnapshots(players, (value) => value.game?.phase === "await-assist-approval");
    await command(
      assister.socket,
      "game:assist-propose",
      { cardId: "club-4" },
      lastSnapshot(assister).revision
    );
    await proposed;

    expect(lastSnapshot(host).game?.assistProposal).toMatchObject({
      proposer: 2,
      card: { cardId: "club-4" }
    });
    for (const player of players.slice(1)) {
      expect(lastSnapshot(player).game).not.toHaveProperty("assistProposal");
    }
  });

  it("rejects stale game revisions and duplicate request ids", async () => {
    const host = await connectClient(serverUrl, clients);
    await command(host.socket, "room:create", { nickname: "甲" });
    await command(host.socket, "room:fill-bots", {});
    await command(host.socket, "room:ready", { ready: true });
    const hostStarted = waitForSnapshot(host.socket, (value) => value.game !== undefined);
    await command(host.socket, "room:start", {});
    await hostStarted;
    const snapshot = lastSnapshot(host);
    const cardId = snapshot.game?.legalActions.find((action) => action.type === "game:attack")?.cardIds?.[0];
    if (cardId === undefined) throw new Error("expected an opening attack");

    const stale = await command(host.socket, "game:attack", { cardId }, snapshot.revision - 1);
    expect(stale).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });

    const illegal = await command(
      host.socket,
      "game:attack",
      { cardId: "not-a-real-card" },
      snapshot.revision
    );
    expect(illegal).toMatchObject({ ok: false, error: { code: "ILLEGAL_ACTION" } });
    expect(lastSnapshot(host).revision).toBe(snapshot.revision);

    const requestId = randomUUID();
    const first = await emitRaw(host.socket, {
      requestId,
      expectedRevision: snapshot.revision,
      type: "game:attack",
      payload: { cardId }
    });
    const duplicate = await emitRaw(host.socket, {
      requestId,
      expectedRevision: snapshot.revision,
      type: "game:attack",
      payload: { cardId }
    });
    expect(first.ok).toBe(true);
    expect(duplicate).toMatchObject({ ok: false, error: { code: "DUPLICATE_REQUEST" } });
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
  socket.on("server:info", (serverInfo: { instanceId: string; persistentRooms: boolean }) => {
    client.serverInfo = serverInfo;
  });
  socket.on("state:snapshot", (snapshot: StateSnapshot) => {
    client.snapshots.push(snapshot);
  });
  await once(socket, "connect");
  return client;
}

function command(
  socket: ClientSocket,
  type: string,
  payload: unknown,
  expectedRevision?: number
): Promise<CommandAck> {
  return emitRaw(socket, {
    requestId: randomUUID(),
    type,
    payload,
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  });
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

async function waitForSnapshots(
  clients: TestClient[],
  predicate: (snapshot: StateSnapshot) => boolean
): Promise<StateSnapshot[]> {
  return Promise.all(clients.map((client) => waitForSnapshot(client.socket, predicate)));
}
