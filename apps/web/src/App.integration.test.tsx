// @vitest-environment jsdom

import type { ClientCommand, CommandAck, StateSnapshot } from "@dabazhang/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App.js";
import { demoGameScenarios } from "./gameTable.js";
import { SocketGameClient, type SocketLike, type SocketStorage } from "./socketClient.js";

type Listener = (...args: unknown[]) => void;

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

class AppSocket implements SocketLike {
  connected = true;
  commandHandler?: (command: ClientCommand, callback: (ack: CommandAck) => void) => void;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener as unknown as Listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.listeners.get(event)?.delete(listener as unknown as Listener);
    return this;
  }

  emit(_event: "command", command: ClientCommand, callback: (ack: CommandAck) => void): this {
    this.commandHandler?.(command, callback);
    return this;
  }

  connect(): this {
    this.connected = true;
    return this;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

afterEach(cleanup);

describe("App realtime integration", () => {
  it("routes authoritative lobby and game snapshots and surfaces a terminated room", async () => {
    const socket = new AppSocket();
    let request = 0;
    const client = new SocketGameClient({
      socket,
      storage: new MemoryStorage(),
      requestIdFactory: () => `00000000-0000-4000-8000-${String(++request).padStart(12, "0")}`,
      ackTimeoutMs: 250
    });
    const lobby = lobbySnapshot();
    socket.commandHandler = (command, callback) => {
      expect(command.type).toBe("room:create");
      socket.trigger("state:snapshot", lobby);
      callback({ requestId: command.requestId, ok: true, revision: lobby.revision });
    };

    render(<App realtimeClient={client} />);
    fireEvent.change(screen.getByLabelText("你的昵称"), { target: { value: "大巴掌" } });
    fireEvent.click(screen.getByRole("button", { name: "创建牌桌" }));

    await screen.findByRole("heading", { name: "四方已摆好，只等人齐" });
    expect(screen.getByText("ABC234")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加机器人" })).toBeTruthy();

    const game = demoGameScenarios["active-round"].game;
    const playing: StateSnapshot = {
      revision: game.revision,
      serverTime: 1_700_000_000_000,
      room: {
        roomCode: "ABC234",
        status: "playing",
        hostSeat: 0,
        selfSeat: 0,
        players: game.players
      },
      game
    };
    socket.trigger("state:snapshot", playing);

    await screen.findByText("联网房间 ABC234");
    expect(screen.queryByText("房间已开始")).toBeNull();
    expect(screen.getByRole("button", { name: "离开本局（机器人接管）" })).toBeTruthy();

    socket.trigger("server:shutdown", { reason: "计划维护，原房间已结束" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "和朋友开一局" })).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("计划维护，原房间已结束");
    client.dispose();
  });
});

function lobbySnapshot(): StateSnapshot {
  return {
    revision: 1,
    serverTime: 1_700_000_000_000,
    room: {
      roomCode: "ABC234",
      status: "lobby",
      hostSeat: 0,
      selfSeat: 0,
      players: [{
        seatId: 0,
        nickname: "大巴掌",
        teamId: 0,
        handCount: 0,
        ready: false,
        online: true,
        controller: "human"
      }]
    },
    resumeToken: "r".repeat(48)
  };
}
