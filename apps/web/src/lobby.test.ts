import { describe, expect, it } from "vitest";
import type { PlayerView, RoomView, SeatId } from "@dabazhang/protocol";
import {
  LocalLobbyClient,
  getSeatLabel,
  getStartBlocker,
  normalizeRoomCode,
  seatToPosition,
  validateNickname,
  validateRoomCode
} from "./lobby.js";

function human(seatId: SeatId, ready = true): PlayerView {
  return {
    seatId,
    nickname: `玩家${seatId}`,
    teamId: seatId % 2 as 0 | 1,
    handCount: 0,
    ready,
    online: true,
    controller: "human"
  };
}

function room(players: PlayerView[], selfSeat: SeatId = 0): RoomView {
  return { roomCode: "BZ8K2Q", status: "lobby", hostSeat: 0, selfSeat, players };
}

describe("lobby input rules", () => {
  it("normalizes room codes without accepting ambiguous characters", () => {
    expect(normalizeRoomCode(" bz8 k2q ")).toBe("BZ8K2Q");
    expect(validateRoomCode("BZ8K2Q")).toBeNull();
    expect(validateRoomCode("IO10AA")).toContain("6 位房间码");
  });

  it("validates trimmed nicknames", () => {
    expect(validateNickname("  ")).toBe("请输入昵称");
    expect(validateNickname("山河")).toBeNull();
    expect(validateNickname("山".repeat(33))).toContain("32");
  });
});

describe("four-seat presentation", () => {
  it("keeps self at the bottom and teammate at the top", () => {
    expect(seatToPosition(1, 1)).toBe("bottom");
    expect(seatToPosition(2, 1)).toBe("right");
    expect(seatToPosition(3, 1)).toBe("top");
    expect(seatToPosition(0, 1)).toBe("left");
    expect(getSeatLabel("top")).toBe("对家 · 队友");
  });
});

describe("room start conditions", () => {
  it("requires four occupied seats and all humans ready", () => {
    expect(getStartBlocker(room([human(0), human(1), human(2)]))).toContain("四个座位");
    expect(getStartBlocker(room([human(0), human(1, false), human(2), human(3)]))).toContain("准备");
    expect(getStartBlocker(room([human(0), human(1), human(2), human(3)]))).toBeNull();
  });

  it("allows only the host to start", () => {
    expect(getStartBlocker(room([human(0), human(1), human(2), human(3)], 1))).toContain("房主");
  });

  it("fills every open seat with a ready bot", async () => {
    const client = new LocalLobbyClient();
    const filled = await client.fillBots(room([human(0)]));
    expect(filled.players).toHaveLength(4);
    expect(filled.players.filter((player) => player.controller === "bot-fixed")).toHaveLength(3);
    expect(filled.players.every((player) => player.ready)).toBe(true);
  });

  it("adds one bot at a time and refuses to exceed four seats", async () => {
    const client = new LocalLobbyClient();
    const first = await client.addBot(room([human(0)]));
    expect(first.players).toHaveLength(2);
    expect(first.players[1]).toMatchObject({ seatId: 1, controller: "bot-fixed", ready: true });

    await expect(client.addBot(room([human(0), human(1), human(2), human(3)]))).rejects.toThrow("坐满");
  });

  it("still requires a disconnected human seat to be ready", () => {
    const disconnected = { ...human(1, false), online: false, controller: "human-grace" as const };
    expect(getStartBlocker(room([human(0), disconnected, human(2), human(3)]))).toContain("准备");
  });
});
