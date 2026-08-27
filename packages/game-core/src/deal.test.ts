import { describe, expect, it } from "vitest";

import { createDeck, isJoker, type CardId } from "./cards.js";
import { createInitialGame, dealEightRounds, placeRandomNonJokerAtBottom } from "./deal.js";
import type { RandomSource } from "./random.js";

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("initial game", () => {
  it("puts a non-joker indicator at the bottom", () => {
    const prepared = placeRandomNonJokerAtBottom(createDeck(), seededRandom(7));
    const indicator = prepared.at(-1);

    expect(indicator).toBeDefined();
    expect(isJoker(indicator!)).toBe(false);
  });

  it("deals eight cards per player and leaves 22 cards", () => {
    const state = createInitialGame({ rng: seededRandom(42) });

    expect(state.players[0].hand).toHaveLength(8);
    expect(state.players[1].hand).toHaveLength(8);
    expect(state.players[2].hand).toHaveLength(8);
    expect(state.players[3].hand).toHaveLength(8);
    expect(state.drawPile).toHaveLength(22);
    expect(state.drawPile.at(-1)).toBe(state.originalIndicatorCardId);
    expect(isJoker(state.cardsById[state.originalIndicatorCardId]!)).toBe(false);

    const allZoneIds = [...state.drawPile, ...Object.values(state.players).flatMap((player) => player.hand)];
    expect(allZoneIds).toHaveLength(54);
    expect(new Set(allZoneIds)).toHaveLength(54);
  });

  it("deals one card at a time counter-clockwise for eight rounds", () => {
    const ids = Array.from({ length: 54 }, (_, index) => `card-${index}` as CardId);
    const result = dealEightRounds(ids, 3);

    expect(result.hands[3]).toEqual(["card-0", "card-4", "card-8", "card-12", "card-16", "card-20", "card-24", "card-28"]);
    expect(result.hands[0]).toEqual(["card-1", "card-5", "card-9", "card-13", "card-17", "card-21", "card-25", "card-29"]);
    expect(result.hands[1][0]).toBe("card-2");
    expect(result.hands[2][0]).toBe("card-3");
    expect(result.drawPile).toEqual(ids.slice(32));
  });

  it("is reproducible with an injected deterministic random source", () => {
    const first = createInitialGame({ rng: seededRandom(20260828) });
    const second = createInitialGame({ rng: seededRandom(20260828) });

    expect(second).toEqual(first);
  });
});
