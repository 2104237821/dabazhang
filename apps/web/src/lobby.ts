import type { PlayerView, RoomView, SeatId } from "@dabazhang/protocol";

export type TablePosition = "bottom" | "right" | "top" | "left";

export interface LobbyClient {
  createRoom(nickname: string): Promise<RoomView>;
  joinRoom(nickname: string, roomCode: string): Promise<RoomView>;
  setReady(room: RoomView, ready: boolean): Promise<RoomView>;
  addBot(room: RoomView): Promise<RoomView>;
  fillBots(room: RoomView): Promise<RoomView>;
  removeBot(room: RoomView, seatId: SeatId): Promise<RoomView>;
  startRoom(room: RoomView): Promise<RoomView>;
  leaveRoom(room: RoomView): Promise<void>;
}

const roomCodePattern = /^[A-HJ-NP-Z2-9]{6}$/;
const mockRoomCode = "BZ8K2Q";
const botNames = ["青竹", "流云", "松墨", "远山"] as const;

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/\s/g, "").slice(0, 6);
}

export function validateNickname(value: string): string | null {
  const nickname = value.trim();
  if (!nickname) return "请输入昵称";
  if (nickname.length > 32) return "昵称不能超过 32 个字符";
  return null;
}

export function validateRoomCode(value: string): string | null {
  if (!roomCodePattern.test(normalizeRoomCode(value))) {
    return "请输入 6 位房间码（不含 0、1、I、O）";
  }
  return null;
}

export function seatToPosition(seatId: SeatId, selfSeat: SeatId): TablePosition {
  const offset = (seatId - selfSeat + 4) % 4;
  return (["bottom", "right", "top", "left"] as const)[offset] ?? "bottom";
}

export function getSeatLabel(position: TablePosition): string {
  switch (position) {
    case "bottom":
      return "我";
    case "right":
      return "下家";
    case "top":
      return "对家 · 队友";
    case "left":
      return "上家";
  }
}

export function getStartBlocker(room: RoomView): string | null {
  if (room.status !== "lobby") return "游戏已经开始";
  if (room.selfSeat !== room.hostSeat) return "只有房主可以开始";
  if (room.players.length !== 4) return "需要四个座位全部入座";
  if (room.players.some((player) => player.controller !== "bot-fixed" && !player.ready)) {
    return "所有真人玩家准备后才能开始";
  }
  return null;
}

export function getPlayerAtSeat(room: RoomView, seatId: SeatId): PlayerView | undefined {
  return room.players.find((player) => player.seatId === seatId);
}

function createHuman(seatId: SeatId, nickname: string, ready: boolean): PlayerView {
  return {
    seatId,
    nickname,
    teamId: seatId % 2 as 0 | 1,
    handCount: 0,
    ready,
    online: true,
    controller: "human"
  };
}

function createBot(seatId: SeatId, index: number): PlayerView {
  return {
    seatId,
    nickname: `机器人·${botNames[index % botNames.length]}`,
    teamId: seatId % 2 as 0 | 1,
    handCount: 0,
    ready: true,
    online: true,
    controller: "bot-fixed"
  };
}

function cloneRoom(room: RoomView, players = room.players): RoomView {
  return { ...room, players: players.map((player) => ({ ...player })) };
}

function waitForUi(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 180));
}

export class LocalLobbyClient implements LobbyClient {
  async createRoom(nickname: string): Promise<RoomView> {
    await waitForUi();
    return {
      roomCode: mockRoomCode,
      status: "lobby",
      hostSeat: 0,
      selfSeat: 0,
      players: [createHuman(0, nickname.trim(), false)]
    };
  }

  async joinRoom(nickname: string, roomCode: string): Promise<RoomView> {
    await waitForUi();
    return {
      roomCode: normalizeRoomCode(roomCode),
      status: "lobby",
      hostSeat: 0,
      selfSeat: 1,
      players: [createHuman(0, "房主·山河", true), createHuman(1, nickname.trim(), false)]
    };
  }

  async setReady(room: RoomView, ready: boolean): Promise<RoomView> {
    await waitForUi();
    return cloneRoom(
      room,
      room.players.map((player) => player.seatId === room.selfSeat ? { ...player, ready } : player)
    );
  }

  async fillBots(room: RoomView): Promise<RoomView> {
    await waitForUi();
    const players = room.players.map((player) => ({ ...player }));
    let botIndex = players.filter((player) => player.controller === "bot-fixed").length;
    for (const seatId of [0, 1, 2, 3] as const) {
      if (!players.some((player) => player.seatId === seatId)) {
        players.push(createBot(seatId, botIndex));
        botIndex += 1;
      }
    }
    players.sort((a, b) => a.seatId - b.seatId);
    return cloneRoom(room, players);
  }

  async addBot(room: RoomView): Promise<RoomView> {
    await waitForUi();
    const seatId = ([0, 1, 2, 3] as const).find(
      (candidate) => !room.players.some((player) => player.seatId === candidate)
    );
    if (seatId === undefined) throw new Error("房间已经坐满了");
    const botIndex = room.players.filter((player) => player.controller === "bot-fixed").length;
    return cloneRoom(room, [...room.players, createBot(seatId, botIndex)].sort((left, right) => left.seatId - right.seatId));
  }

  async removeBot(room: RoomView, seatId: SeatId): Promise<RoomView> {
    await waitForUi();
    return cloneRoom(room, room.players.filter((player) => !(player.seatId === seatId && player.controller === "bot-fixed")));
  }

  async startRoom(room: RoomView): Promise<RoomView> {
    await waitForUi();
    const blocker = getStartBlocker(room);
    if (blocker) throw new Error(blocker);
    return { ...cloneRoom(room), status: "playing" };
  }

  async leaveRoom(): Promise<void> {
    await waitForUi();
  }
}
