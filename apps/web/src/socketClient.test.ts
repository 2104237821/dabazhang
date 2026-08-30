import type { ClientCommand, CommandAck, StateSnapshot } from "@dabazhang/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  RESUME_SESSION_STORAGE_KEY,
  SocketGameClient,
  type SocketLike,
  type SocketStorage
} from "./socketClient.js";
import type { SocketCommandError } from "./socketClient.js";

type TestListener = (...args: unknown[]) => void;

class MemoryStorage implements SocketStorage {
  readonly values = new Map<string, string>();

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

class FakeSocket implements SocketLike {
  connected = false;
  readonly commands: ClientCommand[] = [];
  commandHandler?: (command: ClientCommand, callback: (ack: CommandAck) => void) => void;
  private readonly listeners = new Map<string, Set<TestListener>>();

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set<TestListener>();
    listeners.add(listener as unknown as TestListener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.listeners.get(event)?.delete(listener as unknown as TestListener);
    return this;
  }

  emit(_event: "command", command: ClientCommand, callback: (ack: CommandAck) => void): this {
    this.commands.push(command);
    this.commandHandler?.(command, callback);
    return this;
  }

  connect(): this {
    if (!this.connected) {
      this.connected = true;
      this.trigger("connect");
    }
    return this;
  }

  disconnect(): this {
    if (this.connected) {
      this.connected = false;
      this.trigger("disconnect", "io client disconnect");
    }
    return this;
  }

  serverConnect(instanceId = "server-a"): void {
    this.connect();
    this.trigger("server:info", { instanceId, persistentRooms: false });
  }

  transportDisconnect(reason = "transport close"): void {
    this.connected = false;
    this.trigger("disconnect", reason);
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe("SocketGameClient", () => {
  it("uses the exact authoritative snapshot object and persists only its own resume token", async () => {
    const socket = new FakeSocket();
    const storage = new MemoryStorage();
    const client = createClient(socket, storage);
    socket.serverConnect();
    const created = makeSnapshot(1, "ABC234", "t".repeat(48));
    socket.commandHandler = (command, callback) => {
      expect(command).toMatchObject({ type: "room:create", payload: { nickname: "甲" } });
      socket.trigger("state:snapshot", created);
      callback({ requestId: command.requestId, ok: true, revision: 1 });
    };

    await expect(client.createRoom("甲")).resolves.toBe(created.room);
    expect(client.getState().snapshot).toBe(created);
    expect(JSON.parse(storage.getItem(RESUME_SESSION_STORAGE_KEY) ?? "null")).toEqual({
      roomCode: "ABC234",
      resumeToken: "t".repeat(48),
      instanceId: "server-a"
    });
    client.dispose();
  });

  it("records late server identity without trying to resume an already active socket", async () => {
    const socket = new FakeSocket();
    const storage = new MemoryStorage();
    const client = createClient(socket, storage);
    const created = makeSnapshot(1, "ABC234", "t".repeat(48));
    socket.commandHandler = (command, callback) => {
      socket.trigger("state:snapshot", created);
      callback({ requestId: command.requestId, ok: true, revision: 1 });
    };

    await client.createRoom("甲");
    socket.trigger("server:info", { instanceId: "server-late", persistentRooms: false });

    expect(socket.commands).toHaveLength(1);
    expect(JSON.parse(storage.getItem(RESUME_SESSION_STORAGE_KEY) ?? "null")).toMatchObject({
      roomCode: "ABC234",
      instanceId: "server-late"
    });
    client.dispose();
  });

  it("drops lower revisions while accepting equal and newer real socket snapshots", () => {
    const socket = new FakeSocket();
    socket.serverConnect();
    const client = createClient(socket, new MemoryStorage());
    const revisionFive = makeSnapshot(5);
    const stale = makeSnapshot(4);
    const equal = makeSnapshot(5);
    const newer = makeSnapshot(6);
    const observed: StateSnapshot[] = [];
    client.subscribe((state) => {
      if (state.snapshot !== undefined) observed.push(state.snapshot);
    });

    socket.trigger("state:snapshot", revisionFive);
    socket.trigger("state:snapshot", stale);
    expect(client.getState().snapshot).toBe(revisionFive);
    socket.trigger("state:snapshot", equal);
    expect(client.getState().snapshot).toBe(equal);
    socket.trigger("state:snapshot", newer);
    expect(client.getState().snapshot).toBe(newer);
    expect(observed).toEqual([revisionFive, equal, newer]);
    client.dispose();
  });

  it("maps lobby convenience methods to ACKed commands and propagates server errors", async () => {
    const socket = new FakeSocket();
    socket.serverConnect();
    const client = createClient(socket, new MemoryStorage());
    const initial = makeSnapshot(2);
    socket.trigger("state:snapshot", initial);
    let revision = 2;
    socket.commandHandler = (command, callback) => {
      if (command.type === "room:remove-bot") {
        callback({
          requestId: command.requestId,
          ok: false,
          error: { code: "NOT_HOST", message: "只有房主可以执行该操作" }
        });
        return;
      }
      revision += 1;
      socket.trigger("state:snapshot", makeSnapshot(revision));
      callback({ requestId: command.requestId, ok: true, revision });
    };

    await client.setReady(initial.room, true);
    await client.addBot(initial.room);
    await client.fillBots(initial.room);
    await client.startRoom(initial.room);
    await expect(client.removeBot(initial.room, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SocketCommandError>>({
        code: "NOT_HOST",
        message: "只有房主可以执行该操作"
      })
    );
    expect(socket.commands.map((command) => command.type)).toEqual([
      "room:ready",
      "room:add-bot",
      "room:fill-bots",
      "room:start",
      "room:remove-bot"
    ]);
    client.dispose();
  });

  it("automatically resumes on every connection generation and exposes reconnect state", async () => {
    const socket = new FakeSocket();
    const storage = storedSession("ABC234", "r".repeat(48), "server-a");
    const client = createClient(socket, storage);
    let revision = 7;
    socket.commandHandler = (command, callback) => {
      expect(command.type).toBe("room:resume");
      socket.trigger("state:snapshot", makeSnapshot(revision));
      callback({ requestId: command.requestId, ok: true, revision });
    };

    socket.serverConnect("server-a");
    await vi.waitFor(() => expect(client.getState().restoring).toBe(false));
    expect(client.getState()).toMatchObject({
      connectionState: "connected",
      connectionGeneration: 1,
      notice: "已恢复房间 ABC234"
    });

    socket.transportDisconnect();
    expect(client.getState()).toMatchObject({
      connectionState: "reconnecting",
      restoring: true
    });
    revision = 8;
    socket.serverConnect("server-a");
    await vi.waitFor(() => expect(socket.commands).toHaveLength(2));
    await vi.waitFor(() => expect(client.getState().restoring).toBe(false));
    expect(client.getState().connectionGeneration).toBe(2);
    expect(client.getState().snapshot?.revision).toBe(8);
    client.dispose();
  });

  it("keeps controls reconnecting until resume ACK and its authoritative snapshot arrive", async () => {
    const socket = new FakeSocket();
    const storage = storedSession("ABC234", "r".repeat(48), "server-a");
    const client = createClient(socket, storage);
    let finishResume: (() => void) | undefined;
    socket.commandHandler = (command, callback) => {
      finishResume = () => {
        socket.trigger("state:snapshot", makeSnapshot(12));
        callback({ requestId: command.requestId, ok: true, revision: 12 });
      };
    };

    socket.serverConnect("server-a");
    expect(client.getState()).toMatchObject({
      connectionState: "reconnecting",
      connectionGeneration: 1,
      restoring: true
    });
    expect(finishResume).toBeTypeOf("function");

    finishResume?.();
    await vi.waitFor(() => expect(client.getState()).toMatchObject({
      connectionState: "connected",
      restoring: false
    }));
    client.dispose();
  });

  it("ends a saved room without attempting resume when the server instance changed", () => {
    const socket = new FakeSocket();
    const storage = storedSession("ABC234", "r".repeat(48), "server-old");
    const client = createClient(socket, storage);

    socket.serverConnect("server-new");

    expect(socket.commands).toHaveLength(0);
    expect(client.getState()).toMatchObject({
      restoring: false,
      connectionState: "disconnected",
      terminalErrorCode: "SERVER_RESTARTED",
      terminalError: "原房间已结束，服务器已经重启"
    });
    expect(storage.getItem(RESUME_SESSION_STORAGE_KEY)).toBeNull();
    client.dispose();
  });

  it("does not erase the shared resume token when another tab replaces this session", () => {
    const socket = new FakeSocket();
    const storage = storedSession("ABC234", "r".repeat(48), "server-a");
    const savedValue = storage.getItem(RESUME_SESSION_STORAGE_KEY);
    const client = createClient(socket, storage);

    socket.trigger("session:replaced", { code: "SESSION_REPLACED" });
    socket.trigger("state:snapshot", makeSnapshot(20));

    expect(client.getState()).toMatchObject({
      restoring: false,
      connectionState: "disconnected",
      terminalErrorCode: "SESSION_REPLACED"
    });
    expect(client.getStoredSession()).toBeUndefined();
    expect(client.getState().snapshot).toBeUndefined();
    expect(storage.getItem(RESUME_SESSION_STORAGE_KEY)).toBe(savedValue);
    client.dispose();
  });

  it("clears persisted recovery on explicit leave and authoritative shutdown", async () => {
    const leaveSocket = new FakeSocket();
    leaveSocket.serverConnect();
    const leaveStorage = storedSession("ABC234", "r".repeat(48), "server-a");
    const leavingClient = createClient(leaveSocket, leaveStorage);
    const current = makeSnapshot(9);
    leaveSocket.trigger("state:snapshot", current);
    leaveSocket.commandHandler = (command, callback) => {
      callback({ requestId: command.requestId, ok: true, revision: 10 });
    };

    await leavingClient.leaveRoom(current.room);
    expect(leavingClient.getState().snapshot).toBeUndefined();
    expect(leaveStorage.getItem(RESUME_SESSION_STORAGE_KEY)).toBeNull();
    leavingClient.dispose();

    const shutdownSocket = new FakeSocket();
    const shutdownStorage = storedSession("ABC234", "s".repeat(48), "server-a");
    const shutdownClient = createClient(shutdownSocket, shutdownStorage);
    shutdownSocket.trigger("server:shutdown", { reason: "计划维护" });
    expect(shutdownClient.getState()).toMatchObject({
      terminalErrorCode: "SERVER_RESTARTED",
      terminalError: "计划维护"
    });
    expect(shutdownStorage.getItem(RESUME_SESSION_STORAGE_KEY)).toBeNull();
    shutdownClient.dispose();
  });
});

function createClient(socket: FakeSocket, storage: MemoryStorage): SocketGameClient {
  let request = 0;
  return new SocketGameClient({
    socket,
    storage,
    requestIdFactory: () => `00000000-0000-4000-8000-${String(++request).padStart(12, "0")}`,
    ackTimeoutMs: 250,
    connectionTimeoutMs: 250
  });
}

function storedSession(
  roomCode: string,
  resumeToken: string,
  instanceId: string
): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(
    RESUME_SESSION_STORAGE_KEY,
    JSON.stringify({ roomCode, resumeToken, instanceId })
  );
  return storage;
}

function makeSnapshot(
  revision: number,
  roomCode = "ABC234",
  resumeToken?: string
): StateSnapshot {
  return {
    revision,
    serverTime: 1_700_000_000_000 + revision,
    room: {
      roomCode,
      status: "lobby",
      hostSeat: 0,
      selfSeat: 0,
      players: [{
        seatId: 0,
        nickname: "甲",
        teamId: 0,
        handCount: 0,
        ready: false,
        online: true,
        controller: "human"
      }]
    },
    ...(resumeToken === undefined ? {} : { resumeToken })
  };
}
