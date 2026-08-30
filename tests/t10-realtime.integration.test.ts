import { randomUUID } from "node:crypto";

import { createGameServer } from "../apps/server/src/server.js";
import { io as createSocketClient } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";

import { SocketGameClient, type SocketLike, type SocketStorage } from "../apps/web/src/socketClient.js";

class MemoryStorage implements SocketStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("SocketGameClient with the real server", () => {
  it("creates, starts, plays, reconnects and leaves without exposing hidden cards", async () => {
    const server = createGameServer({
      roomManagerOptions: {
        rng: () => 0,
        botDelayMs: () => 30_000,
        decisionTimeoutMs: 30_000,
        disconnectGraceMs: 1_000
      }
    });
    const serverUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = createSocketClient(serverUrl, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"]
    });
    const client = new SocketGameClient({
      socket: socket as unknown as SocketLike,
      storage: new MemoryStorage(),
      requestIdFactory: randomUUID,
      ackTimeoutMs: 2_000,
      connectionTimeoutMs: 2_000
    });

    try {
      let room = await client.createRoom("甲");
      room = await client.fillBots(room);
      room = await client.setReady(room, true);
      room = await client.startRoom(room);

      expect(room.status).toBe("playing");
      const started = client.getState().snapshot;
      expect(started?.game?.players.find((player) => player.seatId === room.selfSeat)?.hand).toHaveLength(8);
      expect(
        started?.game?.players
          .filter((player) => player.seatId !== room.selfSeat)
          .every((player) => player.hand === undefined)
      ).toBe(true);
      expect(started?.game).not.toHaveProperty("drawPile");
      expect(started?.game).not.toHaveProperty("cardsById");

      const attack = started?.game?.legalActions.find((action) => action.type === "game:attack");
      const cardId = attack?.cardIds?.[0];
      expect(cardId).toBeTypeOf("string");
      if (cardId === undefined || started === undefined) throw new Error("expected a legal opening attack");
      const ack = await client.sendCommand({
        requestId: randomUUID(),
        expectedRevision: started.revision,
        type: "game:attack",
        payload: { cardId }
      });
      expect(ack.ok).toBe(true);
      await vi.waitFor(() => expect(client.getState().snapshot?.revision).toBeGreaterThan(started.revision));

      const seatBeforeReconnect = client.getState().snapshot?.room.selfSeat;
      socket.disconnect();
      expect(client.getState().connectionState).toBe("reconnecting");
      socket.connect();
      await vi.waitFor(
        () => expect(client.getState()).toMatchObject({ connectionState: "connected", restoring: false }),
        { timeout: 2_000 }
      );
      expect(client.getState().snapshot?.room.selfSeat).toBe(seatBeforeReconnect);

      const resumedRoom = client.getState().snapshot?.room;
      if (resumedRoom === undefined) throw new Error("expected a resumed room");
      await client.leaveRoom(resumedRoom);
      expect(client.getState().snapshot).toBeUndefined();
      expect(client.getStoredSession()).toBeUndefined();
    } finally {
      client.dispose();
      await server.close();
    }
  });
});
