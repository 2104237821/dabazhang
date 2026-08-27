import { createHash, randomBytes, randomInt } from "node:crypto";

import type {
  CommandErrorCode,
  PlayerView,
  RoomView,
  SeatId,
  StateSnapshot,
  TeamId
} from "@dabazhang/protocol";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_ROOM_CODE_ATTEMPTS = 1_000;

type HumanController = "human" | "human-grace";

interface HumanSeat {
  readonly kind: "human";
  readonly seatId: SeatId;
  readonly sessionId: string;
  readonly nickname: string;
  readonly joinedOrder: number;
  ready: boolean;
  online: boolean;
  controller: HumanController;
}

interface BotSeat {
  readonly kind: "bot";
  readonly seatId: SeatId;
  readonly nickname: string;
  readonly joinedOrder: number;
}

type RoomSeat = HumanSeat | BotSeat;

interface GuestSession {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly roomCode: string;
  readonly seatId: SeatId;
  socketId?: string;
}

interface RoomState {
  readonly roomCode: string;
  readonly seats: Array<RoomSeat | undefined>;
  status: RoomView["status"];
  hostSeat: SeatId;
  revision: number;
}

export interface StartGameSeat {
  seatId: SeatId;
  teamId: TeamId;
  nickname: string;
  controller: "human" | "bot-fixed";
}

export interface StartGameContext {
  roomCode: string;
  seats: [StartGameSeat, StartGameSeat, StartGameSeat, StartGameSeat];
}

export type StartGameHandler = (context: StartGameContext) => Promise<void> | void;

export interface RoomManagerOptions {
  startGame?: StartGameHandler;
  codeGenerator?: () => string;
  tokenGenerator?: () => string;
  now?: () => number;
}

export interface RoomMutationResult {
  roomCode: string;
  revision?: number;
  resumeToken?: string;
  replacedSocketId?: string;
}

export interface SocketSnapshot {
  socketId: string;
  snapshot: StateSnapshot;
}

export class RoomCommandError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RoomCommandError";
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomState>();
  private readonly sessionsByToken = new Map<string, GuestSession>();
  private readonly sessionIdsBySocket = new Map<string, string>();
  private readonly sessionsById = new Map<string, GuestSession>();
  private readonly roomQueues = new Map<string, Promise<void>>();
  private readonly startGame: StartGameHandler;
  private readonly codeGenerator: () => string;
  private readonly tokenGenerator: () => string;
  private readonly now: () => number;
  private joinedOrder = 0;

  constructor(options: RoomManagerOptions = {}) {
    this.startGame = options.startGame ?? (() => undefined);
    this.codeGenerator = options.codeGenerator ?? generateRoomCode;
    this.tokenGenerator = options.tokenGenerator ?? generateResumeToken;
    this.now = options.now ?? Date.now;
  }

  async createRoom(socketId: string, nicknameInput: string): Promise<RoomMutationResult> {
    this.assertSocketIsFree(socketId);
    const nickname = normalizeNickname(nicknameInput);
    const roomCode = this.createUniqueRoomCode();
    const resumeToken = this.tokenGenerator();
    const session = this.createSession(roomCode, 0, socketId, resumeToken);
    const host: HumanSeat = {
      kind: "human",
      seatId: 0,
      sessionId: session.sessionId,
      nickname,
      joinedOrder: this.nextJoinedOrder(),
      ready: false,
      online: true,
      controller: "human"
    };
    const room: RoomState = {
      roomCode,
      seats: [host, undefined, undefined, undefined],
      status: "lobby",
      hostSeat: 0,
      revision: 1
    };
    this.rooms.set(roomCode, room);

    return { roomCode, revision: room.revision, resumeToken };
  }

  async joinRoom(socketId: string, roomCodeInput: string, nicknameInput: string): Promise<RoomMutationResult> {
    this.assertSocketIsFree(socketId);
    const roomCode = normalizeRoomCode(roomCodeInput);

    return this.enqueue(roomCode, () => {
      this.assertSocketIsFree(socketId);
      const room = this.requireRoom(roomCode);
      this.assertLobby(room);
      const nickname = normalizeNickname(nicknameInput);
      this.assertNicknameAvailable(room, nickname);
      const seatId = findOpenSeat(room);
      if (seatId === undefined) {
        throw new RoomCommandError("ROOM_FULL", "房间已经坐满了");
      }

      const resumeToken = this.tokenGenerator();
      const session = this.createSession(roomCode, seatId, socketId, resumeToken);
      room.seats[seatId] = {
        kind: "human",
        seatId,
        sessionId: session.sessionId,
        nickname,
        joinedOrder: this.nextJoinedOrder(),
        ready: false,
        online: true,
        controller: "human"
      };
      room.revision += 1;

      return { roomCode, revision: room.revision, resumeToken };
    });
  }

  async resumeRoom(socketId: string, roomCodeInput: string, resumeToken: string): Promise<RoomMutationResult> {
    this.assertSocketIsFree(socketId);
    const roomCode = normalizeRoomCode(roomCodeInput);
    const tokenHash = hashToken(resumeToken);

    return this.enqueue(roomCode, () => {
      this.assertSocketIsFree(socketId);
      const room = this.requireRoom(roomCode);
      const session = this.sessionsByToken.get(tokenHash);
      if (session === undefined || session.roomCode !== roomCode) {
        throw new RoomCommandError("ROOM_NOT_FOUND", "房间或恢复凭证无效");
      }

      const seat = room.seats[session.seatId];
      if (seat?.kind !== "human" || seat.sessionId !== session.sessionId) {
        throw new RoomCommandError("ROOM_NOT_FOUND", "该玩家座位已经不存在");
      }

      const replacedSocketId = session.socketId;
      if (replacedSocketId !== undefined) {
        this.sessionIdsBySocket.delete(replacedSocketId);
      }
      session.socketId = socketId;
      this.sessionIdsBySocket.set(socketId, session.sessionId);

      const presenceChanged = !seat.online || seat.controller !== "human";
      seat.online = true;
      seat.controller = "human";
      if (presenceChanged) {
        room.revision += 1;
      }

      return {
        roomCode,
        revision: room.revision,
        ...(replacedSocketId !== undefined && replacedSocketId !== socketId
          ? { replacedSocketId }
          : {})
      };
    });
  }

  async setReady(socketId: string, ready: boolean): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      if (seat.ready !== ready) {
        seat.ready = ready;
        room.revision += 1;
      }
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async addBot(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      const seatId = findOpenSeat(room);
      if (seatId === undefined) {
        throw new RoomCommandError("ROOM_FULL", "房间已经坐满了");
      }
      room.seats[seatId] = this.createBotSeat(room, seatId);
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async removeBot(socketId: string, seatId: SeatId): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      const target = room.seats[seatId];
      if (target?.kind !== "bot") {
        throw new RoomCommandError("ILLEGAL_ACTION", "该座位不是机器人");
      }
      room.seats[seatId] = undefined;
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async fillBots(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      let added = false;
      for (const seatId of [0, 1, 2, 3] as const) {
        if (room.seats[seatId] === undefined) {
          room.seats[seatId] = this.createBotSeat(room, seatId);
          added = true;
        }
      }
      if (added) {
        room.revision += 1;
      }
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async startRoom(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, async ({ room, seat }) => {
      this.assertLobby(room);
      this.assertHost(room, seat.seatId);
      if (room.seats.some((candidate) => candidate === undefined)) {
        throw new RoomCommandError("NOT_READY", "需要四个座位全部有人或机器人才能开始");
      }
      if (room.seats.some((candidate) => candidate?.kind === "human" && !candidate.ready)) {
        throw new RoomCommandError("NOT_READY", "所有真人玩家准备后才能开始");
      }

      const seats = room.seats.map((candidate) => {
        if (candidate === undefined) {
          throw new RoomCommandError("NOT_READY", "座位尚未坐满");
        }
        return {
          seatId: candidate.seatId,
          teamId: teamFor(candidate.seatId),
          nickname: candidate.nickname,
          controller: candidate.kind === "bot" ? "bot-fixed" : "human"
        } satisfies StartGameSeat;
      }) as StartGameContext["seats"];

      await this.startGame({ roomCode: room.roomCode, seats });
      room.status = "playing";
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async leaveRoom(socketId: string): Promise<RoomMutationResult> {
    return this.withHumanSeat(socketId, ({ room, seat, session }) => {
      this.assertLobby(room);
      this.removeSession(session);
      room.seats[seat.seatId] = undefined;

      const remainingHumans = room.seats.filter(
        (candidate): candidate is HumanSeat => candidate?.kind === "human"
      );
      if (remainingHumans.length === 0) {
        this.rooms.delete(room.roomCode);
        this.roomQueues.delete(room.roomCode);
        return { roomCode: room.roomCode };
      }

      if (room.hostSeat === seat.seatId) {
        remainingHumans.sort((left, right) => left.joinedOrder - right.joinedOrder);
        const nextHost = remainingHumans[0];
        if (nextHost !== undefined) {
          room.hostSeat = nextHost.seatId;
        }
      }
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  async disconnect(socketId: string): Promise<RoomMutationResult | undefined> {
    const session = this.getSessionForSocket(socketId);
    if (session === undefined) {
      return undefined;
    }

    return this.enqueue(session.roomCode, () => {
      const currentSession = this.sessionsById.get(session.sessionId);
      if (currentSession?.socketId !== socketId) {
        return undefined;
      }
      const room = this.rooms.get(session.roomCode);
      const seat = room?.seats[session.seatId];
      this.sessionIdsBySocket.delete(socketId);
      delete currentSession.socketId;
      if (room === undefined || seat?.kind !== "human") {
        return undefined;
      }
      seat.online = false;
      seat.controller = "human-grace";
      room.revision += 1;
      return { roomCode: room.roomCode, revision: room.revision };
    });
  }

  getConnectedSnapshots(roomCodeInput: string): SocketSnapshot[] {
    const roomCode = normalizeRoomCode(roomCodeInput);
    const room = this.rooms.get(roomCode);
    if (room === undefined) {
      return [];
    }

    const snapshots: SocketSnapshot[] = [];
    for (const seat of room.seats) {
      if (seat?.kind !== "human") {
        continue;
      }
      const session = this.sessionsById.get(seat.sessionId);
      if (session?.socketId === undefined) {
        continue;
      }
      snapshots.push({
        socketId: session.socketId,
        snapshot: this.buildSnapshot(room, seat.seatId)
      });
    }
    return snapshots;
  }

  getSnapshotForSocket(socketId: string, resumeToken?: string): StateSnapshot {
    const session = this.requireSessionForSocket(socketId);
    const room = this.requireRoom(session.roomCode);
    return this.buildSnapshot(room, session.seatId, resumeToken);
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  private async withHumanSeat<T>(
    socketId: string,
    operation: (context: {
      room: RoomState;
      seat: HumanSeat;
      session: GuestSession;
    }) => Promise<T> | T
  ): Promise<T> {
    const initialSession = this.requireSessionForSocket(socketId);
    return this.enqueue(initialSession.roomCode, () => {
      const session = this.requireSessionForSocket(socketId);
      const room = this.requireRoom(session.roomCode);
      const seat = room.seats[session.seatId];
      if (seat?.kind !== "human" || seat.sessionId !== session.sessionId) {
        throw new RoomCommandError("NOT_IN_ROOM", "当前连接没有有效玩家座位");
      }
      return operation({ room, seat, session });
    });
  }

  private buildSnapshot(room: RoomState, selfSeat: SeatId, resumeToken?: string): StateSnapshot {
    const players = room.seats
      .filter((seat): seat is RoomSeat => seat !== undefined)
      .map((seat) => this.buildPlayerView(seat));
    const roomView: RoomView = {
      roomCode: room.roomCode,
      status: room.status,
      hostSeat: room.hostSeat,
      selfSeat,
      players
    };
    return {
      revision: room.revision,
      serverTime: this.now(),
      room: roomView,
      ...(resumeToken === undefined ? {} : { resumeToken })
    };
  }

  private buildPlayerView(seat: RoomSeat): PlayerView {
    if (seat.kind === "bot") {
      return {
        seatId: seat.seatId,
        nickname: seat.nickname,
        teamId: teamFor(seat.seatId),
        handCount: 0,
        ready: true,
        online: true,
        controller: "bot-fixed"
      };
    }
    return {
      seatId: seat.seatId,
      nickname: seat.nickname,
      teamId: teamFor(seat.seatId),
      handCount: 0,
      ready: seat.ready,
      online: seat.online,
      controller: seat.controller
    };
  }

  private createSession(
    roomCode: string,
    seatId: SeatId,
    socketId: string,
    resumeToken: string
  ): GuestSession {
    const tokenHash = hashToken(resumeToken);
    if (this.sessionsByToken.has(tokenHash)) {
      throw new RoomCommandError("BAD_REQUEST", "无法创建唯一恢复凭证，请重试");
    }
    const session: GuestSession = {
      sessionId: randomBytes(16).toString("base64url"),
      tokenHash,
      roomCode,
      seatId,
      socketId
    };
    this.sessionsByToken.set(tokenHash, session);
    this.sessionsById.set(session.sessionId, session);
    this.sessionIdsBySocket.set(socketId, session.sessionId);
    return session;
  }

  private removeSession(session: GuestSession): void {
    this.sessionsByToken.delete(session.tokenHash);
    this.sessionsById.delete(session.sessionId);
    if (session.socketId !== undefined) {
      this.sessionIdsBySocket.delete(session.socketId);
    }
  }

  private createBotSeat(room: RoomState, seatId: SeatId): BotSeat {
    const baseNickname = `机器人${seatId + 1}`;
    let nickname = baseNickname;
    let suffix = 2;
    while (this.nicknameExists(room, nickname)) {
      nickname = `${baseNickname}-${suffix}`;
      suffix += 1;
    }
    return {
      kind: "bot",
      seatId,
      nickname,
      joinedOrder: this.nextJoinedOrder()
    };
  }

  private assertSocketIsFree(socketId: string): void {
    if (this.sessionIdsBySocket.has(socketId)) {
      throw new RoomCommandError("BAD_REQUEST", "当前连接已经加入房间");
    }
  }

  private assertNicknameAvailable(room: RoomState, nickname: string): void {
    if (this.nicknameExists(room, nickname)) {
      throw new RoomCommandError("NICKNAME_TAKEN", "该昵称已在房间中使用");
    }
  }

  private nicknameExists(room: RoomState, nickname: string): boolean {
    const key = nicknameKey(nickname);
    return room.seats.some(
      (seat) => seat !== undefined && nicknameKey(seat.nickname) === key
    );
  }

  private assertLobby(room: RoomState): void {
    if (room.status !== "lobby") {
      throw new RoomCommandError("GAME_ALREADY_STARTED", "游戏已经开始");
    }
  }

  private assertHost(room: RoomState, seatId: SeatId): void {
    if (room.hostSeat !== seatId) {
      throw new RoomCommandError("NOT_HOST", "只有房主可以执行该操作");
    }
  }

  private requireRoom(roomCode: string): RoomState {
    const room = this.rooms.get(roomCode);
    if (room === undefined) {
      throw new RoomCommandError("ROOM_NOT_FOUND", "房间不存在");
    }
    return room;
  }

  private getSessionForSocket(socketId: string): GuestSession | undefined {
    const sessionId = this.sessionIdsBySocket.get(socketId);
    return sessionId === undefined ? undefined : this.sessionsById.get(sessionId);
  }

  private requireSessionForSocket(socketId: string): GuestSession {
    const session = this.getSessionForSocket(socketId);
    if (session === undefined) {
      throw new RoomCommandError("NOT_IN_ROOM", "当前连接尚未加入房间");
    }
    return session;
  }

  private createUniqueRoomCode(): string {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
      const candidate = normalizeRoomCode(this.codeGenerator());
      if (/^[A-HJ-NP-Z2-9]{6}$/.test(candidate) && !this.rooms.has(candidate)) {
        return candidate;
      }
    }
    throw new RoomCommandError("BAD_REQUEST", "暂时无法分配房间码，请稍后重试");
  }

  private nextJoinedOrder(): number {
    this.joinedOrder += 1;
    return this.joinedOrder;
  }

  private enqueue<T>(roomCode: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.roomQueues.get(roomCode) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.roomQueues.set(roomCode, tail);
    void tail.finally(() => {
      if (this.roomQueues.get(roomCode) === tail) {
        this.roomQueues.delete(roomCode);
      }
    });
    return result;
  }
}

function normalizeRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

function normalizeNickname(nickname: string): string {
  const normalized = nickname.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 32 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new RoomCommandError("BAD_REQUEST", "昵称格式无效");
  }
  return normalized;
}

function nicknameKey(nickname: string): string {
  return nickname.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function generateResumeToken(): string {
  return randomBytes(32).toString("base64url");
}

function generateRoomCode(): string {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function findOpenSeat(room: RoomState): SeatId | undefined {
  return ([0, 1, 2, 3] as const).find((seatId) => room.seats[seatId] === undefined);
}

function teamFor(seatId: SeatId): TeamId {
  return (seatId % 2) as TeamId;
}
