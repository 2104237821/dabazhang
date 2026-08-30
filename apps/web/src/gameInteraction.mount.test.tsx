// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, GameViewState, StateSnapshot } from "@dabazhang/protocol";
import type { GameClient } from "./gameClient.js";
import { GameInteractionScreen, GameRoundStatus } from "./gameInteraction.js";
import { demoGameScenarios } from "./gameTable.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function gameWith(overrides: Partial<GameViewState> = {}): GameViewState {
  return {
    ...demoGameScenarios["active-round"].game,
    legalActions: [{ type: "game:take" }],
    ...overrides
  };
}

function snapshot(game: GameViewState, hostSeat: 0 | 1 | 2 | 3 = 0): StateSnapshot {
  return {
    revision: game.revision,
    serverTime: 10_000,
    room: {
      roomCode: "BZ8K2Q",
      status: game.phase === "finished" ? "post-game" : "playing",
      hostSeat,
      selfSeat: game.selfSeat,
      players: game.players
    },
    game
  };
}

function sequenceIds(...ids: string[]) {
  let index = 0;
  return () => ids[index++] ?? `request-${index}`;
}

describe("mounted game interaction lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("deduplicates a double click while the first command is pending", () => {
    const result = deferred<CommandAck>();
    const client: GameClient = { sendCommand: vi.fn(() => result.promise) };
    render(
      <GameInteractionScreen
        snapshot={snapshot(gameWith())}
        client={client}
        requestIdFactory={sequenceIds("request-1", "request-2")}
      />
    );

    const take = screen.getByRole("button", { name: "主动收牌" });
    fireEvent.click(take);
    fireEvent.click(take);

    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    expect((take as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("正在发送操作…")).toBeTruthy();
  });

  it("unlocks after ACK then a same-revision authoritative snapshot", async () => {
    const result = deferred<CommandAck>();
    const client: GameClient = { sendCommand: () => result.promise };
    const initial = snapshot(gameWith());
    const view = render(
      <GameInteractionScreen snapshot={initial} client={client} requestIdFactory={() => "request-1"} />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));

    await act(async () => result.resolve({ requestId: "request-1", ok: true, revision: 19 }));
    expect(screen.getByText("服务器已确认，等待最新牌桌状态…")).toBeTruthy();

    view.rerender(
      <GameInteractionScreen snapshot={{ ...initial }} client={client} requestIdFactory={() => "request-2"} />
    );
    expect(screen.queryByText("服务器已确认，等待最新牌桌状态…")).toBeNull();
    expect((screen.getByRole("button", { name: "主动收牌" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets a newer snapshot win when it arrives before a late ACK", async () => {
    const first = deferred<CommandAck>();
    const second = deferred<CommandAck>();
    const client: GameClient = {
      sendCommand: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
    };
    const initial = snapshot(gameWith());
    const view = render(
      <GameInteractionScreen snapshot={initial} client={client} requestIdFactory={sequenceIds("request-1", "request-2")} />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));

    view.rerender(
      <GameInteractionScreen
        snapshot={snapshot(gameWith({ revision: 19 }))}
        client={client}
        requestIdFactory={sequenceIds("request-2")}
      />
    );
    const take = screen.getByRole("button", { name: "主动收牌" });
    expect((take as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(take);
    expect(client.sendCommand).toHaveBeenCalledTimes(2);

    await act(async () => first.resolve({ requestId: "request-1", ok: true, revision: 19 }));
    expect(screen.getByText("正在发送操作…")).toBeTruthy();
    second.resolve({ requestId: "request-2", ok: true, revision: 20 });
  });

  it("surfaces a rejected ACK and transport rejection, then unlocks", async () => {
    const rejectedAck: GameClient = {
      sendCommand: async (command) => ({
        requestId: command.requestId,
        ok: false,
        error: { code: "ILLEGAL_ACTION", message: "服务器拒绝了这步" }
      })
    };
    const view = render(
      <GameInteractionScreen snapshot={snapshot(gameWith())} client={rejectedAck} requestIdFactory={() => "request-1"} />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toContain("服务器拒绝了这步");
    expect((screen.getByRole("button", { name: "主动收牌" }) as HTMLButtonElement).disabled).toBe(false);

    const transportFailure: GameClient = { sendCommand: async () => { throw new Error("网络失败"); } };
    view.rerender(
      <GameInteractionScreen snapshot={{ ...snapshot(gameWith()) }} client={transportFailure} requestIdFactory={() => "request-2"} />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toContain("网络失败");
  });

  it("times out an ACK using an injectable timeout and ignores its late resolution", async () => {
    const result = deferred<CommandAck>();
    const client: GameClient = { sendCommand: () => result.promise };
    render(
      <GameInteractionScreen
        snapshot={snapshot(gameWith())}
        client={client}
        requestIdFactory={() => "request-1"}
        ackTimeoutMs={100}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));

    await act(async () => vi.advanceTimersByTime(100));
    expect(screen.getByRole("alert").textContent).toContain("服务器确认超时");
    expect((screen.getByRole("button", { name: "主动收牌" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => result.resolve({ requestId: "request-1", ok: true, revision: 19 }));
    expect(screen.getByRole("alert").textContent).toContain("服务器确认超时");
  });

  it("uses a ten second ACK timeout by default", async () => {
    const result = deferred<CommandAck>();
    const client: GameClient = { sendCommand: () => result.promise };
    render(
      <GameInteractionScreen
        snapshot={snapshot(gameWith())}
        client={client}
        requestIdFactory={() => "request-1"}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));

    await act(async () => vi.advanceTimersByTime(9_999));
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert").textContent).toContain("服务器确认超时");
  });

  it("invalidates a pending request and disables controls while disconnected", () => {
    const result = deferred<CommandAck>();
    const client: GameClient = { sendCommand: () => result.promise };
    const initial = snapshot(gameWith());
    const view = render(
      <GameInteractionScreen snapshot={initial} client={client} requestIdFactory={() => "request-1"} />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));

    view.rerender(
      <GameInteractionScreen
        snapshot={initial}
        client={client}
        connectionState="disconnected"
        connectionGeneration={2}
        requestIdFactory={() => "request-2"}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("连接已中断");
    expect((screen.getByRole("button", { name: "主动收牌" }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(
      <GameInteractionScreen
        snapshot={initial}
        client={client}
        connectionState="connected"
        connectionGeneration={3}
        requestIdFactory={() => "request-2"}
      />
    );
    expect((screen.getByRole("button", { name: "主动收牌" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("turns an acknowledged request into a retryable error on a new connection generation", async () => {
    const client: GameClient = {
      sendCommand: async (command) => ({ requestId: command.requestId, ok: true, revision: 19 })
    };
    const initial = snapshot(gameWith());
    const view = render(
      <GameInteractionScreen snapshot={initial} client={client} requestIdFactory={() => "request-1"} />
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "主动收牌" })));
    expect(screen.getByText("服务器已确认，等待最新牌桌状态…")).toBeTruthy();

    view.rerender(
      <GameInteractionScreen
        snapshot={initial}
        client={client}
        connectionGeneration={2}
        requestIdFactory={() => "request-2"}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("连接已恢复");
    expect((screen.getByRole("button", { name: "主动收牌" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores ACK resolution after unmount and clears timeout and countdown intervals", async () => {
    const result = deferred<CommandAck>();
    const client: GameClient = { sendCommand: () => result.promise };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <GameInteractionScreen
        snapshot={snapshot(gameWith({ decisionDeadline: 55_000 }))}
        client={client}
        requestIdFactory={() => "request-1"}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "主动收牌" }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => result.resolve({ requestId: "request-1", ok: true, revision: 19 }));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("cleans the round countdown interval on unmount", () => {
    const game = gameWith({ decisionDeadline: 55_000 });
    const view = render(<GameRoundStatus game={game} serverTime={10_000} connectionState="connected" />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("play again ownership", () => {
  it("shows the command only to the host and tells other players to wait", () => {
    const finished = gameWith({ phase: "finished", winner: 0, legalActions: [] });
    const client: GameClient = { sendCommand: vi.fn() };
    const hostView = render(<GameInteractionScreen snapshot={snapshot(finished, finished.selfSeat)} client={client} />);
    expect(screen.getByRole("button", { name: "再来一局" })).toBeTruthy();
    hostView.unmount();

    render(<GameInteractionScreen snapshot={snapshot(finished, 1)} client={client} />);
    expect(screen.queryByRole("button", { name: "再来一局" })).toBeNull();
    expect(screen.getByText("等待房主开始下一局")).toBeTruthy();
  });
});
