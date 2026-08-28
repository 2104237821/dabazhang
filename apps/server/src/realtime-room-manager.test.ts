import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoomManager } from "./room-manager.js";

describe("RoomManager realtime control", () => {
  let managers: RoomManager[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    managers = [];
  });

  afterEach(() => {
    for (const manager of managers) manager.close();
    vi.useRealTimers();
  });

  it("uses a bot for exactly the expired online decision and starts a fresh human deadline", async () => {
    const { manager } = createRealtimeManager(managers, { botDelayMs: () => 10 });
    await startHostWithBots(manager);
    const before = manager.getSnapshotForSocket("host");
    expect(before.game).toMatchObject({
      phase: "await-opening-attack",
      decisionDeadline: 46_000,
      primaryAttacker: 0
    });

    await vi.advanceTimersByTimeAsync(44_999);
    expect(manager.getSnapshotForSocket("host").revision).toBe(before.revision);
    await vi.advanceTimersByTimeAsync(1);

    const afterTimedStep = manager.getSnapshotForSocket("host");
    expect(afterTimedStep.revision).toBe(before.revision + 1);
    expect(afterTimedStep.game).toMatchObject({ phase: "await-defense" });
    expect(afterTimedStep.room.players[0]).toMatchObject({ controller: "human", online: true });

    await vi.advanceTimersByTimeAsync(10);
    const afterFixedBot = manager.getSnapshotForSocket("host");
    expect(afterFixedBot.room.players[0]).toMatchObject({ controller: "human", online: true });
    if (afterFixedBot.game?.primaryAttacker === 0) {
      expect(afterFixedBot.game.decisionDeadline).toBe(91_010);
    }
  });

  it("resumes at 59 seconds without takeover", async () => {
    const { manager, resumeToken } = await createStartedManager(managers);
    const gameRevision = manager.getSnapshotForSocket("host").game?.revision;
    await manager.disconnect("host");
    await vi.advanceTimersByTimeAsync(59_000);
    await manager.resumeRoom("host-restored", "ABC234", resumeToken);

    const restored = manager.getSnapshotForSocket("host-restored");
    expect(restored.room.players[0]).toMatchObject({
      online: true,
      controller: "human"
    });
    expect(restored.game?.revision).toBeGreaterThan(gameRevision ?? 0);
    expect(restored.game?.table).toHaveLength(0);
  });

  it("reclaims immediately when the takeover bot decision is queued but has not run", async () => {
    const { manager, resumeToken } = await createStartedManager(managers, { botDelayMs: () => 10 });
    await manager.disconnect("host");
    await vi.advanceTimersByTimeAsync(60_000);

    await manager.resumeRoom("host-restored", "ABC234", resumeToken);
    const restored = manager.getSnapshotForSocket("host-restored");
    expect(restored.room.players[0]).toMatchObject({
      online: true,
      controller: "human"
    });
    expect(restored.game).toMatchObject({
      phase: "await-opening-attack",
      table: [],
      decisionDeadline: 106_000
    });

    await vi.advanceTimersByTimeAsync(10);
    const afterOriginalBotDelay = manager.getSnapshotForSocket("host-restored");
    expect(afterOriginalBotDelay.revision).toBe(restored.revision);
    expect(afterOriginalBotDelay.game?.table).toEqual(restored.game?.table);
  });

  it("does not roll back a takeover bot action that completed before resume", async () => {
    const { manager, resumeToken } = await createStartedManager(managers, { botDelayMs: () => 10 });
    await manager.disconnect("host");
    await vi.advanceTimersByTimeAsync(60_010);

    await manager.resumeRoom("host-restored", "ABC234", resumeToken);
    const restored = manager.getSnapshotForSocket("host-restored");
    expect(restored.room.players[0]).toMatchObject({ online: true, controller: "human" });
    expect(restored.game).toMatchObject({
      phase: "await-defense",
      table: [{ attacker: 0 }]
    });
  });

  it("can finish a mixed game through timeout steps and starts the rematch with the first finisher", async () => {
    const { manager } = await createStartedManager(managers, { botDelayMs: () => 1 });
    await vi.runAllTimersAsync();

    const finished = manager.getSnapshotForSocket("host");
    expect(finished.room.status).toBe("post-game");
    expect(finished.game?.winner).toBeTypeOf("number");
    const firstFinisher = finished.game?.finishedOrder[0];
    expect(firstFinisher).toBeTypeOf("number");

    await manager.playAgain("host");
    const rematch = manager.getSnapshotForSocket("host");
    expect(rematch.room.status).toBe("playing");
    expect(rematch.game?.primaryAttacker).toBe(firstFinisher);
  });
});

function createRealtimeManager(
  managers: RoomManager[],
  options: { botDelayMs?: () => number } = {}
): { manager: RoomManager } {
  let tokenSequence = 0;
  const manager = new RoomManager({
    codeGenerator: () => "ABC234",
    tokenGenerator: () => `resume-token-${String(++tokenSequence).padStart(32, "0")}`,
    rng: () => 0,
    now: Date.now,
    decisionTimeoutMs: 45_000,
    disconnectGraceMs: 60_000,
    botDelayMs: options.botDelayMs ?? (() => 10)
  });
  managers.push(manager);
  return { manager };
}

async function createStartedManager(
  managers: RoomManager[],
  options: { botDelayMs?: () => number } = {}
): Promise<{ manager: RoomManager; resumeToken: string }> {
  const { manager } = createRealtimeManager(managers, options);
  const created = await manager.createRoom("host", "甲");
  if (created.resumeToken === undefined) throw new Error("missing resume token");
  await manager.fillBots("host");
  await manager.setReady("host", true);
  await manager.startRoom("host");
  return { manager, resumeToken: created.resumeToken };
}

async function startHostWithBots(manager: RoomManager): Promise<void> {
  await manager.createRoom("host", "甲");
  await manager.fillBots("host");
  await manager.setReady("host", true);
  await manager.startRoom("host");
}
