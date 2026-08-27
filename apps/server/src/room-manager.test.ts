import { describe, expect, it, vi } from "vitest";

import { RoomCommandError, RoomManager } from "./room-manager.js";

function createManager(startGame = vi.fn()) {
  let tokenSequence = 0;
  return {
    manager: new RoomManager({
      codeGenerator: () => "ABC234",
      tokenGenerator: () => `resume-token-${String(++tokenSequence).padStart(32, "0")}`,
      now: () => 1_234,
      startGame
    }),
    startGame
  };
}

describe("RoomManager", () => {
  it("creates a room with a valid six-character code and a private resume token", async () => {
    const { manager } = createManager();

    const result = await manager.createRoom("host-socket", " 房主 ");
    const publicSnapshot = manager.getSnapshotForSocket("host-socket");
    const privateSnapshot = manager.getSnapshotForSocket("host-socket", result.resumeToken);

    expect(result.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(result.resumeToken).toHaveLength(45);
    expect(publicSnapshot).not.toHaveProperty("resumeToken");
    expect(privateSnapshot.resumeToken).toBe(result.resumeToken);
    expect(publicSnapshot).toMatchObject({
      revision: 1,
      serverTime: 1_234,
      room: {
        status: "lobby",
        hostSeat: 0,
        selfSeat: 0,
        players: [
          {
            nickname: "房主",
            handCount: 0,
            ready: false,
            online: true,
            controller: "human"
          }
        ]
      }
    });
    expect(publicSnapshot.room.players[0]).not.toHaveProperty("hand");
  });

  it("requires the host, four occupied seats, and every human to be ready", async () => {
    const startGame = vi.fn();
    const { manager } = createManager(startGame);
    const created = await manager.createRoom("host", "甲");
    await manager.joinRoom("guest", created.roomCode, "乙");

    await expect(manager.addBot("guest")).rejects.toMatchObject({ code: "NOT_HOST" });
    await manager.fillBots("host");
    const botSeat = manager
      .getSnapshotForSocket("host")
      .room.players.find((player) => player.controller === "bot-fixed")?.seatId;
    if (botSeat === undefined) {
      throw new Error("expected a bot seat");
    }
    await manager.removeBot("host", botSeat);
    await manager.addBot("host");
    await manager.setReady("host", true);
    await expect(manager.startRoom("host")).rejects.toMatchObject({ code: "NOT_READY" });

    await manager.setReady("guest", true);
    await manager.startRoom("host");

    const snapshot = manager.getSnapshotForSocket("host");
    expect(snapshot.room.status).toBe("playing");
    expect(snapshot.room.players).toHaveLength(4);
    expect(snapshot.room.players.filter((player) => player.controller === "bot-fixed")).toHaveLength(2);
    expect(startGame).toHaveBeenCalledOnce();
    expect(startGame).toHaveBeenCalledWith({
      roomCode: created.roomCode,
      seats: [
        expect.objectContaining({ seatId: 0, teamId: 0, controller: "human" }),
        expect.objectContaining({ seatId: 1, teamId: 1, controller: "human" }),
        expect.objectContaining({ seatId: 2, teamId: 0, controller: "bot-fixed" }),
        expect.objectContaining({ seatId: 3, teamId: 1, controller: "bot-fixed" })
      ]
    });
    await expect(manager.setReady("host", false)).rejects.toMatchObject({
      code: "GAME_ALREADY_STARTED"
    });
  });

  it("serializes simultaneous joins so only one player can take the last seat", async () => {
    const { manager } = createManager();
    const created = await manager.createRoom("host", "甲");
    await manager.addBot("host");
    await manager.addBot("host");

    const results = await Promise.allSettled([
      manager.joinRoom("guest-a", created.roomCode, "乙"),
      manager.joinRoom("guest-b", created.roomCode, "丙")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(RoomCommandError);
      expect(rejected.reason).toMatchObject({ code: "ROOM_FULL" });
    }
    expect(manager.getSnapshotForSocket("host").room.players).toHaveLength(4);
  });

  it("replaces an existing socket for the same token and ignores the old disconnect", async () => {
    const { manager } = createManager();
    const created = await manager.createRoom("old-socket", "甲");
    if (created.resumeToken === undefined) {
      throw new Error("missing resume token");
    }

    const resumed = await manager.resumeRoom("new-socket", created.roomCode, created.resumeToken);
    expect(resumed.replacedSocketId).toBe("old-socket");
    expect(() => manager.getSnapshotForSocket("old-socket")).toThrowError(
      expect.objectContaining({ code: "NOT_IN_ROOM" })
    );
    await expect(manager.disconnect("old-socket")).resolves.toBeUndefined();
    expect(manager.getSnapshotForSocket("new-socket").room.players[0]).toMatchObject({
      online: true,
      controller: "human"
    });

    await manager.disconnect("new-socket");
    const secondResume = await manager.resumeRoom("third-socket", created.roomCode, created.resumeToken);
    expect(secondResume.revision).toBeGreaterThan(resumed.revision ?? 0);
    expect(manager.getSnapshotForSocket("third-socket").room.players[0]).toMatchObject({
      online: true,
      controller: "human"
    });
  });

  it("transfers lobby ownership when the host leaves", async () => {
    const { manager } = createManager();
    const created = await manager.createRoom("host", "甲");
    await manager.joinRoom("guest", created.roomCode, "乙");

    await manager.leaveRoom("host");

    const snapshot = manager.getSnapshotForSocket("guest");
    expect(snapshot.room.hostSeat).toBe(snapshot.room.selfSeat);
    expect(snapshot.room.players).toHaveLength(1);
    await expect(manager.addBot("guest")).resolves.toMatchObject({ roomCode: created.roomCode });
  });
});
