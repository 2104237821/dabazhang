import type {
  ClientCommand,
  CommandAck,
  CommandErrorCode,
  RoomView,
  SeatId,
  StateSnapshot
} from "@dabazhang/protocol";
import { io as createSocket } from "socket.io-client";

import type { ConnectionState, GameClient, RequestIdFactory } from "./gameClient.js";
import { defaultRequestIdFactory } from "./gameClient.js";
import type { LobbyClient } from "./lobby.js";

export const RESUME_SESSION_STORAGE_KEY = "dabazhang.resume-session.v1";

export interface ResumeSession {
  roomCode: string;
  resumeToken: string;
  instanceId?: string;
}

export type SocketClientTerminalCode = "SERVER_RESTARTED" | "SESSION_REPLACED" | "ROOM_NOT_FOUND";

export interface SocketClientState {
  connectionState: ConnectionState;
  connectionGeneration: number;
  restoring: boolean;
  snapshot?: StateSnapshot;
  notice?: string;
  terminalError?: string;
  terminalErrorCode?: SocketClientTerminalCode;
}

export interface SocketStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SocketLike {
  readonly connected: boolean;
  on(event: string, listener: (...args: never[]) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
  emit(event: "command", command: ClientCommand, callback: (ack: CommandAck) => void): this;
  connect(): this;
  disconnect(): this;
}

export interface SocketGameClientOptions {
  url?: string;
  socket?: SocketLike;
  storage?: SocketStorage;
  requestIdFactory?: RequestIdFactory;
  ackTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export class SocketCommandError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SocketCommandError";
  }
}

type StateListener = (state: SocketClientState) => void;

interface PendingCommand {
  reject(error: Error): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

interface SnapshotWaiter {
  minimumSerial: number;
  minimumRevision?: number;
  roomCode?: string;
  resolve(snapshot: StateSnapshot): void;
  reject(error: Error): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Same-origin Socket.IO adapter used by both the lobby and the authoritative game UI.
 * The snapshot reference is always the exact object received from `state:snapshot`;
 * command ACKs never synthesize or clone authoritative state.
 */
export class SocketGameClient implements LobbyClient, GameClient {
  private readonly socket: SocketLike;
  private readonly storage: SocketStorage | undefined;
  private readonly requestIdFactory: RequestIdFactory;
  private readonly ackTimeoutMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly listeners = new Set<StateListener>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly snapshotWaiters = new Set<SnapshotWaiter>();
  private resumeSession: ResumeSession | undefined;
  private currentSnapshot: StateSnapshot | undefined;
  private currentServerInstanceId: string | undefined;
  private snapshotSerial = 0;
  private connectionGeneration: number;
  private connectionState: ConnectionState;
  private restoring = false;
  private notice: string | undefined;
  private terminalError: string | undefined;
  private terminalErrorCode: SocketClientTerminalCode | undefined;
  private resumeAttemptGeneration = -1;
  private disposed = false;

  constructor(options: SocketGameClientOptions = {}) {
    this.socket = options.socket ?? createSocket(options.url, { autoConnect: true }) as SocketLike;
    this.storage = options.storage ?? readBrowserStorage();
    this.requestIdFactory = options.requestIdFactory ?? defaultRequestIdFactory;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.resumeSession = readResumeSession(this.storage);
    this.connectionState = this.socket.connected && this.resumeSession === undefined
      ? "connected"
      : "reconnecting";
    this.connectionGeneration = this.socket.connected ? 1 : 0;
    this.restoring = this.resumeSession !== undefined;

    this.socket.on("connect", this.handleConnect);
    this.socket.on("disconnect", this.handleDisconnect);
    this.socket.on("connect_error", this.handleConnectError);
    this.socket.on("server:info", this.handleServerInfo);
    this.socket.on("state:snapshot", this.handleSnapshot);
    this.socket.on("server:shutdown", this.handleServerShutdown);
    this.socket.on("session:replaced", this.handleSessionReplaced);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): SocketClientState {
    return {
      connectionState: this.connectionState,
      connectionGeneration: this.connectionGeneration,
      restoring: this.restoring,
      ...(this.currentSnapshot === undefined ? {} : { snapshot: this.currentSnapshot }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      ...(this.terminalError === undefined ? {} : { terminalError: this.terminalError }),
      ...(this.terminalErrorCode === undefined ? {} : { terminalErrorCode: this.terminalErrorCode })
    };
  }

  getStoredSession(): ResumeSession | undefined {
    return this.resumeSession === undefined ? undefined : { ...this.resumeSession };
  }

  async createRoom(nickname: string): Promise<RoomView> {
    this.assertNotRestoring();
    this.prepareForNewSession();
    await this.ensureConnected();
    return this.runRoomMutation({
      requestId: this.requestIdFactory(),
      type: "room:create",
      payload: { nickname }
    });
  }

  async joinRoom(nickname: string, roomCode: string): Promise<RoomView> {
    this.assertNotRestoring();
    this.prepareForNewSession();
    await this.ensureConnected();
    return this.runRoomMutation(
      { requestId: this.requestIdFactory(), type: "room:join", payload: { roomCode, nickname } },
      roomCode
    );
  }

  async resumeStoredSession(): Promise<StateSnapshot | undefined> {
    if (this.resumeSession === undefined) {
      this.restoring = false;
      this.publish();
      return undefined;
    }
    await this.ensureConnected();
    return this.resumeCurrentSession(this.connectionGeneration);
  }

  async setReady(_room: RoomView, ready: boolean): Promise<RoomView> {
    return this.runRoomMutation({
      requestId: this.requestIdFactory(),
      type: "room:ready",
      payload: { ready }
    });
  }

  async addBot(_room: RoomView): Promise<RoomView> {
    void _room;
    return this.runRoomMutation({
      requestId: this.requestIdFactory(),
      type: "room:add-bot",
      payload: {}
    });
  }

  async fillBots(_room: RoomView): Promise<RoomView> {
    void _room;
    return this.runRoomMutation({
      requestId: this.requestIdFactory(),
      type: "room:fill-bots",
      payload: {}
    });
  }

  async removeBot(_room: RoomView, seatId: SeatId): Promise<RoomView> {
    return this.runRoomMutation({
      requestId: this.requestIdFactory(),
      type: "room:remove-bot",
      payload: { seatId }
    });
  }

  async startRoom(_room: RoomView): Promise<RoomView> {
    void _room;
    return this.runRoomMutation({
      requestId: this.requestIdFactory(),
      type: "room:start",
      payload: {}
    });
  }

  async leaveRoom(_room: RoomView): Promise<void> {
    void _room;
    const ack = await this.sendCommand({
      requestId: this.requestIdFactory(),
      type: "room:leave",
      payload: {}
    });
    assertSuccessfulAck(ack);
    this.clearResumeSession();
    this.currentSnapshot = undefined;
    this.restoring = false;
    this.notice = "已离开房间";
    this.terminalError = undefined;
    this.terminalErrorCode = undefined;
    this.rejectSnapshotWaiters(new Error("已离开房间"));
    this.publish();
  }

  sendCommand(command: ClientCommand): Promise<CommandAck> {
    if (this.disposed) return Promise.reject(new Error("连接已经关闭"));
    if (!this.socket.connected) return Promise.reject(new Error("当前未连接到服务器"));

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ack?: CommandAck, error?: Error) => {
        if (settled) return;
        settled = true;
        const pending = this.pendingCommands.get(command.requestId);
        if (pending !== undefined) globalThis.clearTimeout(pending.timer);
        this.pendingCommands.delete(command.requestId);
        if (error !== undefined) reject(error);
        else if (ack !== undefined) resolve(ack);
      };
      const timer = globalThis.setTimeout(() => {
        finish(undefined, new Error("服务器响应超时，请检查网络后重试"));
      }, this.ackTimeoutMs);
      this.pendingCommands.set(command.requestId, {
        timer,
        reject: (error) => finish(undefined, error)
      });
      this.socket.emit("command", command, (ack) => finish(ack));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.off("connect", this.handleConnect);
    this.socket.off("disconnect", this.handleDisconnect);
    this.socket.off("connect_error", this.handleConnectError);
    this.socket.off("server:info", this.handleServerInfo);
    this.socket.off("state:snapshot", this.handleSnapshot);
    this.socket.off("server:shutdown", this.handleServerShutdown);
    this.socket.off("session:replaced", this.handleSessionReplaced);
    this.rejectPendingCommands(new Error("连接已经关闭"));
    this.rejectSnapshotWaiters(new Error("连接已经关闭"));
    this.listeners.clear();
    this.socket.disconnect();
  }

  private readonly handleConnect = () => {
    if (this.disposed) return;
    this.connectionGeneration += 1;
    this.currentServerInstanceId = undefined;
    this.restoring = this.resumeSession !== undefined;
    this.connectionState = this.restoring ? "reconnecting" : "connected";
    this.notice = this.restoring ? "连接成功，正在恢复房间" : "已连接到服务器";
    this.publish();
  };

  private readonly handleDisconnect = (reason?: string) => {
    if (this.disposed) return;
    const reconnecting = reason !== "io server disconnect" && this.terminalError === undefined;
    this.connectionState = reconnecting ? "reconnecting" : "disconnected";
    this.currentServerInstanceId = undefined;
    this.restoring = reconnecting && this.resumeSession !== undefined;
    this.notice = reconnecting ? "连接中断，正在重新连接" : "已与服务器断开";
    this.rejectPendingCommands(new Error("连接已中断，请重试"));
    this.rejectSnapshotWaiters(new Error("连接已中断，请重试"));
    this.publish();
  };

  private readonly handleConnectError = () => {
    if (this.disposed || this.terminalError !== undefined) return;
    this.connectionState = "reconnecting";
    this.notice = "暂时无法连接服务器，正在重试";
    this.publish();
  };

  private readonly handleServerInfo = (info: unknown) => {
    if (this.disposed || !isServerInfo(info)) return;
    this.currentServerInstanceId = info.instanceId;
    const saved = this.resumeSession;
    if (saved === undefined) {
      this.restoring = false;
      this.connectionState = this.socket.connected ? "connected" : this.connectionState;
      this.publish();
      return;
    }
    if (
      !this.restoring
      && this.currentSnapshot?.room.roomCode === saved.roomCode
      && this.socket.connected
    ) {
      this.saveResumeSession({ ...saved, instanceId: info.instanceId });
      this.connectionState = "connected";
      this.publish();
      return;
    }
    if (saved.instanceId !== undefined && saved.instanceId !== info.instanceId) {
      this.markTerminal("SERVER_RESTARTED", "原房间已结束，服务器已经重启");
      return;
    }
    void this.resumeCurrentSession(this.connectionGeneration).catch(() => undefined);
  };

  private readonly handleSnapshot = (snapshot: unknown) => {
    if (this.disposed || this.terminalError !== undefined || !isStateSnapshot(snapshot)) return;
    if (this.currentSnapshot !== undefined && snapshot.revision < this.currentSnapshot.revision) return;

    this.currentSnapshot = snapshot;
    this.snapshotSerial += 1;
    if (snapshot.resumeToken !== undefined) {
      this.saveResumeSession({
        roomCode: snapshot.room.roomCode,
        resumeToken: snapshot.resumeToken,
        ...(this.currentServerInstanceId === undefined ? {} : { instanceId: this.currentServerInstanceId })
      });
    }
    this.resolveSnapshotWaiters(snapshot);
    this.publish();
  };

  private readonly handleServerShutdown = (value: unknown) => {
    const reason = readMessage(value, "服务器正在维护，原房间已结束");
    this.markTerminal("SERVER_RESTARTED", reason);
  };

  private readonly handleSessionReplaced = () => {
    this.markTerminal(
      "SESSION_REPLACED",
      "当前座位已在另一个页面恢复，本页面停止控制",
      true
    );
  };

  private async runRoomMutation(command: ClientCommand, roomCode?: string): Promise<RoomView> {
    const minimumSerial = this.snapshotSerial + 1;
    const ack = await this.sendCommand(command);
    assertSuccessfulAck(ack);
    const snapshot = await this.waitForSnapshot({
      minimumSerial,
      ...(ack.revision === undefined ? {} : { minimumRevision: ack.revision }),
      ...(roomCode === undefined ? {} : { roomCode })
    });
    return snapshot.room;
  }

  private async resumeCurrentSession(generation: number): Promise<StateSnapshot | undefined> {
    const saved = this.resumeSession;
    if (saved === undefined || !this.socket.connected || this.disposed) return undefined;
    if (this.resumeAttemptGeneration === generation) return this.currentSnapshot;
    this.resumeAttemptGeneration = generation;
    this.restoring = true;
    this.publish();
    const minimumSerial = this.snapshotSerial + 1;

    try {
      const ack = await this.sendCommand({
        requestId: this.requestIdFactory(),
        type: "room:resume",
        payload: { roomCode: saved.roomCode, resumeToken: saved.resumeToken }
      });
      if (!ack.ok) {
        const code = ack.error?.code;
        if (code === "SERVER_RESTARTED" || code === "ROOM_NOT_FOUND") {
          this.markTerminal(code, ack.error?.message ?? "原房间已结束，无法恢复");
          return undefined;
        }
        throw new SocketCommandError(code ?? "BAD_REQUEST", ack.error?.message ?? "恢复房间失败");
      }
      const snapshot = await this.waitForSnapshot({
        minimumSerial,
        ...(ack.revision === undefined ? {} : { minimumRevision: ack.revision }),
        roomCode: saved.roomCode
      });
      this.saveResumeSession({
        roomCode: saved.roomCode,
        resumeToken: saved.resumeToken,
        ...(this.currentServerInstanceId === undefined ? {} : { instanceId: this.currentServerInstanceId })
      });
      this.restoring = false;
      this.connectionState = "connected";
      this.terminalError = undefined;
      this.terminalErrorCode = undefined;
      this.notice = `已恢复房间 ${saved.roomCode}`;
      this.publish();
      return snapshot;
    } catch (error) {
      if (this.connectionGeneration === generation && this.socket.connected) {
        this.restoring = false;
        this.notice = error instanceof Error ? error.message : "恢复房间失败";
        this.publish();
      }
      throw error;
    }
  }

  private waitForSnapshot(criteria: Omit<SnapshotWaiter, "resolve" | "reject" | "timer">): Promise<StateSnapshot> {
    const current = this.currentSnapshot;
    if (current !== undefined && this.snapshotMatches(current, criteria)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiter: SnapshotWaiter = {
        ...criteria,
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          this.snapshotWaiters.delete(waiter);
          reject(new Error("服务器已确认操作，但最新牌桌状态同步超时"));
        }, this.ackTimeoutMs)
      };
      this.snapshotWaiters.add(waiter);
    });
  }

  private snapshotMatches(
    snapshot: StateSnapshot,
    criteria: Pick<SnapshotWaiter, "minimumSerial" | "minimumRevision" | "roomCode">
  ): boolean {
    return this.snapshotSerial >= criteria.minimumSerial
      && (criteria.minimumRevision === undefined || snapshot.revision >= criteria.minimumRevision)
      && (criteria.roomCode === undefined || snapshot.room.roomCode === criteria.roomCode);
  }

  private resolveSnapshotWaiters(snapshot: StateSnapshot): void {
    for (const waiter of this.snapshotWaiters) {
      if (!this.snapshotMatches(snapshot, waiter)) continue;
      this.snapshotWaiters.delete(waiter);
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve(snapshot);
    }
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of [...this.pendingCommands.values()]) pending.reject(error);
  }

  private rejectSnapshotWaiters(error: Error): void {
    for (const waiter of this.snapshotWaiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.snapshotWaiters.clear();
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket;
      let settled = false;
      const onConnect = () => finish();
      const onError = () => finish(new Error("无法连接服务器，请稍后重试"));
      const timer = globalThis.setTimeout(
        () => finish(new Error("连接服务器超时，请稍后重试")),
        this.connectionTimeoutMs
      );
      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
        if (error === undefined) resolve();
        else reject(error);
      }
      this.socket.on("connect", onConnect);
      this.socket.on("connect_error", onError);
      this.socket.connect();
      if (this.socket.connected) finish();
    });
  }

  private prepareForNewSession(): void {
    this.clearResumeSession();
    this.currentSnapshot = undefined;
    this.snapshotSerial = 0;
    this.resumeAttemptGeneration = -1;
    this.restoring = false;
    this.connectionState = this.socket.connected ? "connected" : "reconnecting";
    this.notice = undefined;
    this.terminalError = undefined;
    this.terminalErrorCode = undefined;
    this.publish();
  }

  private assertNotRestoring(): void {
    if (this.restoring) throw new Error("正在恢复上次房间，请稍候");
  }

  private markTerminal(
    code: SocketClientTerminalCode,
    message: string,
    preserveStoredSession = false
  ): void {
    if (preserveStoredSession) this.resumeSession = undefined;
    else this.clearResumeSession();
    this.currentSnapshot = undefined;
    this.restoring = false;
    this.connectionState = "disconnected";
    this.terminalError = message;
    this.terminalErrorCode = code;
    this.notice = message;
    this.rejectPendingCommands(new Error(message));
    this.rejectSnapshotWaiters(new Error(message));
    this.publish();
  }

  private saveResumeSession(session: ResumeSession): void {
    this.resumeSession = session;
    try {
      this.storage?.setItem(RESUME_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Private browsing and quota failures must not end a live game session.
    }
  }

  private clearResumeSession(): void {
    this.resumeSession = undefined;
    try {
      this.storage?.removeItem(RESUME_SESSION_STORAGE_KEY);
    } catch {
      // Storage availability is optional; the active socket can keep playing.
    }
  }

  private publish(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

function assertSuccessfulAck(ack: CommandAck): asserts ack is CommandAck & { ok: true } {
  if (ack.ok) return;
  throw new SocketCommandError(
    ack.error?.code ?? "BAD_REQUEST",
    ack.error?.message ?? "服务器拒绝了当前操作"
  );
}

function readBrowserStorage(): SocketStorage | undefined {
  try {
    return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readResumeSession(storage: SocketStorage | undefined): ResumeSession | undefined {
  try {
    const raw = storage?.getItem(RESUME_SESSION_STORAGE_KEY);
    if (raw === undefined || raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isResumeSession(parsed)) {
      storage?.removeItem(RESUME_SESSION_STORAGE_KEY);
      return undefined;
    }
    return parsed;
  } catch {
    try {
      storage?.removeItem(RESUME_SESSION_STORAGE_KEY);
    } catch {
      // Ignore a second storage failure while cleaning malformed state.
    }
    return undefined;
  }
}

function isResumeSession(value: unknown): value is ResumeSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ResumeSession>;
  return typeof candidate.roomCode === "string"
    && /^[A-HJ-NP-Z2-9]{6}$/.test(candidate.roomCode)
    && typeof candidate.resumeToken === "string"
    && candidate.resumeToken.length >= 32
    && (candidate.instanceId === undefined || typeof candidate.instanceId === "string");
}

function isServerInfo(value: unknown): value is { instanceId: string; persistentRooms: false } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { instanceId?: unknown; persistentRooms?: unknown };
  return typeof candidate.instanceId === "string" && candidate.persistentRooms === false;
}

function isStateSnapshot(value: unknown): value is StateSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { revision?: unknown; room?: { roomCode?: unknown } };
  return Number.isSafeInteger(candidate.revision)
    && typeof candidate.room === "object"
    && candidate.room !== null
    && typeof candidate.room.roomCode === "string";
}

function readMessage(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || !("reason" in value)) return fallback;
  return typeof value.reason === "string" && value.reason.length > 0 ? value.reason : fallback;
}
