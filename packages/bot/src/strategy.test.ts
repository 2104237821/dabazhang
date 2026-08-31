import { describe, expect, it } from "vitest";

import {
  buildPlayerView,
  createInitialGame,
  dispatch,
  type Card,
  type LegalAction,
  type PlayerView
} from "@dabazhang/game-core";

import { chooseBotCommand, chooseBotDecision, shouldExchangeTrumpTwo } from "./strategy.js";

function card(id: string): Card {
  if (id === "joker-small") return { id, suit: "joker", rank: "smallJoker" };
  if (id === "joker-big") return { id, suit: "joker", rank: "bigJoker" };
  const [suit, rank] = id.split("-");
  if (suit === undefined || rank === undefined || !["spade", "heart", "club", "diamond"].includes(suit)) {
    throw new Error(`Bad card id: ${id}`);
  }
  return {
    id,
    suit: suit as "spade" | "heart" | "club" | "diamond",
    rank: Number(rank) as 2
  };
}

function viewWith(hand: string[], legalActions: LegalAction[], overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    revision: 7,
    handNumber: 1,
    selfSeat: 0,
    trumpSuit: "heart",
    drawPileCount: 0,
    players: [
      { seatId: 0, teamId: 0, handCount: hand.length, hand: hand.map(card) },
      { seatId: 1, teamId: 1, handCount: 5 },
      { seatId: 2, teamId: 0, handCount: 5 },
      { seatId: 3, teamId: 1, handCount: 5 }
    ],
    table: [],
    discardPile: [],
    phase: { type: "await-opening-attack" },
    primaryAttacker: 0,
    defender: 1,
    mainTwoSwapAvailable: false,
    finishedOrder: [],
    legalActions,
    ...overrides
  };
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 4_294_967_296;
  };
}

describe("bot strategy", () => {
  it("opens with the lowest non-trump card", () => {
    const view = viewWith(
      ["heart-3", "spade-9", "club-4"],
      [{ type: "play-attack", cardIds: ["heart-3", "spade-9", "club-4"] }]
    );
    expect(chooseBotCommand(view)).toMatchObject({ type: "play-attack", cardId: "club-4" });
  });

  it("preserves jokers and high trump when selecting a defense", () => {
    const view = viewWith(
      ["heart-10", "club-8", "joker-small"],
      [{ type: "play-defense", attackId: "attack-2", cardIds: ["heart-10", "club-8", "joker-small"] }],
      { phase: { type: "await-defense", attackId: "attack-2" }, defender: 0 }
    );
    expect(chooseBotCommand(view)).toMatchObject({ type: "play-defense", cardId: "club-8" });
  });

  it("exchanges the trump two only for a stronger public trump", () => {
    const useful = viewWith(
      ["heart-2", "club-4"],
      [{ type: "exchange-trump-two" }, { type: "decline-trump-two" }],
      { bottomCard: card("heart-14"), phase: { type: "await-main-two-decision", player: 0, context: "deal" } }
    );
    expect(shouldExchangeTrumpTwo(useful)).toBe(true);
    expect(chooseBotCommand(useful)).toMatchObject({ type: "exchange-trump-two" });

    const notUseful = { ...useful, bottomCard: card("club-14") };
    expect(shouldExchangeTrumpTwo(notUseful)).toBe(false);
    expect(chooseBotCommand(notUseful)).toMatchObject({ type: "decline-trump-two" });
  });

  it("approves a legal teammate assist and passes when only jokers remain", () => {
    const approval = viewWith(
      [],
      [{ type: "decide-assist", proposalId: "proposal-8", choices: [true, false] }],
      { phase: { type: "await-assist-approval", proposal: { proposalId: "proposal-8", player: 2, cardId: "club-7" } } }
    );
    expect(chooseBotCommand(approval)).toMatchObject({ type: "decide-assist", accepted: true });

    const pass = viewWith(["joker-big"], [{ type: "pass-attack" }]);
    expect(chooseBotDecision(pass)?.command).toMatchObject({ type: "pass-attack" });
  });

  it("always returns a command accepted by the engine for an initial decision", () => {
    for (let seed = 0; seed < 80; seed += 1) {
      const state = createInitialGame({ rng: seededRandom(seed) });
      const actor = state.phase.type === "await-main-two-decision" ? state.phase.player : state.primaryAttacker;
      const command = chooseBotCommand(buildPlayerView(state, actor));
      expect(command).toBeDefined();
      if (command === undefined) continue;
      expect(dispatch(state, command).ok).toBe(true);
    }
  });

  it("completes full games with four bots without a deadlock", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      let state = createInitialGame({ rng: seededRandom(seed) });
      let steps = 0;
      while (state.phase.type !== "finished" && steps < 2_000) {
        const actor =
          state.phase.type === "await-main-two-decision"
            ? state.phase.player
            : state.phase.type === "await-defense"
              ? state.defender
              : state.primaryAttacker;
        const command = chooseBotCommand(buildPlayerView(state, actor));
        expect(command, `seed ${seed}, phase ${state.phase.type}`).toBeDefined();
        if (command === undefined) break;
        const result = dispatch(state, command);
        expect(result.ok, `seed ${seed}, command ${command.type}`).toBe(true);
        if (!result.ok) break;
        state = result.value.state;
        steps += 1;
      }
      expect(state.phase.type, `seed ${seed} stopped after ${steps} steps`).toBe("finished");
      expect(state.winner).toBeDefined();
    }
  });
});
