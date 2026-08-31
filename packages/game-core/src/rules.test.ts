import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SEATS,
  createCardRegistry,
  createDeck,
  teamForSeat,
  type CardId,
  type SeatId
} from "./cards.js";
import { createInitialGame, createNextHand } from "./deal.js";
import type { GameCommand, GameState, LegalAction, Phase } from "./model.js";
import type { RandomSource } from "./random.js";
import { buildPlayerView, dispatch, getLegalActions, getLegalDefenseCardIds, replay } from "./rules.js";

interface ScenarioOptions {
  readonly hands: Partial<Record<SeatId, CardId[]>>;
  readonly drawPile?: CardId[];
  readonly trumpSuit?: "spade" | "heart" | "club" | "diamond";
  readonly primaryAttacker?: SeatId;
  readonly defender?: SeatId;
  readonly phase?: Phase;
  readonly table?: GameState["table"];
  readonly finishedOrder?: SeatId[];
}

function scenario(options: ScenarioOptions): GameState {
  const deck = createDeck();
  const cardsById = createCardRegistry(deck);
  const drawPile = [...(options.drawPile ?? [])];
  const finishedOrder = [...(options.finishedOrder ?? [])];
  const hands: Record<SeatId, CardId[]> = {
    0: [...(options.hands[0] ?? [])],
    1: [...(options.hands[1] ?? [])],
    2: [...(options.hands[2] ?? [])],
    3: [...(options.hands[3] ?? [])]
  };
  const table = structuredClone(options.table ?? []);
  const used = new Set<CardId>([
    ...drawPile,
    ...Object.values(hands).flat(),
    ...table.flatMap((pair) =>
      pair.defense === undefined ? [pair.attack.cardId] : [pair.attack.cardId, pair.defense.cardId]
    )
  ]);
  expect(used.size).toBe(drawPile.length + Object.values(hands).flat().length + table.flatMap((pair) =>
    pair.defense === undefined ? [pair.attack.cardId] : [pair.attack.cardId, pair.defense.cardId]
  ).length);

  const primaryAttacker = options.primaryAttacker ?? 0;
  const defender = options.defender ?? 1;
  const trumpSuit = options.trumpSuit ?? "heart";
  const bottomCardId = drawPile.at(-1);
  const originalIndicatorCardId = bottomCardId ?? `${trumpSuit}-14`;

  return {
    revision: 0,
    actionSequence: 0,
    handNumber: 1,
    roundNumber: 1,
    cardsById,
    players: {
      0: { seatId: 0, teamId: teamForSeat(0), hand: hands[0], ...(finishedOrder.includes(0) ? { finishedPlace: finishedOrder.indexOf(0) + 1 } : {}) },
      1: { seatId: 1, teamId: teamForSeat(1), hand: hands[1], ...(finishedOrder.includes(1) ? { finishedPlace: finishedOrder.indexOf(1) + 1 } : {}) },
      2: { seatId: 2, teamId: teamForSeat(2), hand: hands[2], ...(finishedOrder.includes(2) ? { finishedPlace: finishedOrder.indexOf(2) + 1 } : {}) },
      3: { seatId: 3, teamId: teamForSeat(3), hand: hands[3], ...(finishedOrder.includes(3) ? { finishedPlace: finishedOrder.indexOf(3) + 1 } : {}) }
    },
    trumpSuit,
    originalIndicatorCardId,
    ...(bottomCardId === undefined ? {} : { visibleBottomCardId: bottomCardId }),
    drawPile,
    table,
    discardPile: deck.map((card) => card.id).filter((id) => !used.has(id)),
    phase: options.phase ?? { type: "await-opening-attack" },
    dealStartSeat: 0,
    primaryAttacker,
    defender,
    mainTwoSwap: {
      enabled: drawPile.length > 0 && originalIndicatorCardId !== `${trumpSuit}-2`,
      used: false,
      ...(bottomCardId === undefined ? {} : { currentBottomCardId: bottomCardId })
    },
    finishedOrder,
    emptiedAtActionSequence: {}
  };
}

function unresolvedAttack(cardId: CardId, player: SeatId = 0, attackId = "attack-1"): GameState["table"] {
  return [{ attackId, attack: { cardId, player, actionSequence: 1 } }];
}

type WithoutRevision<T> = T extends GameCommand ? Omit<T, "expectedRevision"> : never;
type CommandInput = WithoutRevision<GameCommand>;

function apply(state: GameState, command: CommandInput): GameState {
  const result = dispatch(state, { ...command, expectedRevision: state.revision } as GameCommand);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

function seededRandom(seed: number): RandomSource {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 4_294_967_296;
  };
}

function zoneCardIds(state: GameState): CardId[] {
  return [
    ...state.drawPile,
    ...SEATS.flatMap((seat) => state.players[seat].hand),
    ...state.discardPile,
    ...state.table.flatMap((pair) =>
      pair.defense === undefined ? [pair.attack.cardId] : [pair.attack.cardId, pair.defense.cardId]
    )
  ];
}

function commandsFromAction(state: GameState, seat: SeatId, action: LegalAction): GameCommand[] {
  const expectedRevision = state.revision;
  switch (action.type) {
    case "play-attack":
      return action.cardIds.map((cardId) => ({ type: "play-attack", actor: seat, expectedRevision, cardId }));
    case "play-defense":
      return action.cardIds.map((cardId) => ({
        type: "play-defense",
        actor: seat,
        expectedRevision,
        attackId: action.attackId,
        cardId
      }));
    case "collect-table":
    case "pass-attack":
    case "stop-attack":
    case "exchange-trump-two":
    case "decline-trump-two":
      return [{ type: action.type, actor: seat, expectedRevision }];
    case "request-assist":
      return action.cardIds.map((cardId) => ({ type: "request-assist", actor: seat, expectedRevision, cardId }));
    case "decide-assist":
      return action.choices.map((accepted) => ({
        type: "decide-assist",
        actor: seat,
        expectedRevision,
        proposalId: action.proposalId,
        accepted
      }));
  }
}

function allLegalCommands(state: GameState): GameCommand[] {
  return SEATS.flatMap((seat) =>
    getLegalActions(state, seat).flatMap((action) => commandsFromAction(state, seat, action))
  );
}

describe("defense rules", () => {
  it("requires a higher following-suit card when one exists, while always allowing jokers", () => {
    const state = scenario({
      hands: { 0: [], 1: ["club-9", "heart-2", "joker-small", "spade-14"] },
      phase: { type: "await-defense", attackId: "attack-1" },
      table: unresolvedAttack("club-7")
    });

    expect(getLegalDefenseCardIds(state).sort()).toEqual(["club-9", "joker-small"].sort());
  });

  it("allows any trump when no higher following-suit card exists", () => {
    const state = scenario({
      hands: { 0: [], 1: ["club-9", "heart-2", "heart-13", "joker-big", "spade-14"] },
      phase: { type: "await-defense", attackId: "attack-1" },
      table: unresolvedAttack("club-10")
    });

    expect(getLegalDefenseCardIds(state).sort()).toEqual(["heart-2", "heart-13", "joker-big"].sort());
  });

  it("requires a higher trump or joker against a trump attack", () => {
    const state = scenario({
      hands: { 0: [], 1: ["heart-6", "heart-13", "club-14", "joker-small"] },
      phase: { type: "await-defense", attackId: "attack-1" },
      table: unresolvedAttack("heart-10")
    });

    expect(getLegalDefenseCardIds(state).sort()).toEqual(["heart-13", "joker-small"].sort());
  });
});

describe("attack, assistance, and round rotation", () => {
  it("skips an attacker holding only jokers when another player can open", () => {
    let state = scenario({
      hands: { 0: ["joker-small"], 1: ["club-4"], 2: ["joker-big"], 3: ["spade-6"] }
    });

    expect(getLegalActions(state, 0)).toEqual([{ type: "pass-attack" }]);
    state = apply(state, { type: "pass-attack", actor: 0 });
    expect([state.primaryAttacker, state.defender]).toEqual([1, 2]);
    expect(state.players[0].hand).toEqual(["joker-small"]);
    expect(state.phase.type).toBe("await-opening-attack");
  });

  it("retires all remaining jokers in counter-clockwise order when nobody can open", () => {
    let state = scenario({
      hands: { 0: ["joker-small"], 1: ["joker-big"], 2: [], 3: [] },
      finishedOrder: [2, 3]
    });

    state = apply(state, { type: "pass-attack", actor: 0 });
    expect(state.discardPile).toEqual(expect.arrayContaining(["joker-small", "joker-big"]));
    expect(state.finishedOrder).toEqual([2, 3, 0, 1]);
    expect(state.winner).toBe(0);
    expect(state.phase.type).toBe("finished");
  });

  it("forbids joker attacks and only permits table ranks for continuation", () => {
    let state = scenario({
      hands: { 0: ["club-7", "spade-7", "spade-8", "spade-9", "joker-big"], 1: ["club-9", "diamond-3"] }
    });
    expect(getLegalActions(state, 0).find((action) => action.type === "play-attack")).toMatchObject({
      cardIds: ["club-7", "spade-7", "spade-8", "spade-9"]
    });

    state = apply(state, { type: "play-attack", actor: 0, cardId: "club-7" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });
    expect(getLegalActions(state, 0).find((action) => action.type === "play-attack")).toMatchObject({
      cardIds: ["spade-7", "spade-9"]
    });
  });

  it("requires primary-attacker approval before an assist card leaves its hand", () => {
    let state = scenario({
      hands: { 0: ["club-7", "diamond-4"], 1: ["club-9", "diamond-5"], 2: ["spade-7", "spade-5"] }
    });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "club-7" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });
    state = apply(state, { type: "request-assist", actor: 2, cardId: "spade-7" });

    expect(state.players[2].hand).toContain("spade-7");
    expect(buildPlayerView(state, 1).phase).toEqual({ type: "await-assist-approval" });
    state = apply(state, { type: "decide-assist", actor: 0, proposalId: "proposal-3", accepted: true });
    expect(state.players[2].hand).not.toContain("spade-7");
    expect(state.table.at(-1)?.attack.player).toBe(2);
    expect(state.phase.type).toBe("await-defense");
  });

  it("does not permit a third player to assist an attack against the attacker's teammate", () => {
    const state = scenario({
      hands: { 0: ["diamond-3"], 2: ["diamond-4"], 3: ["spade-7"] },
      primaryAttacker: 0,
      defender: 2,
      finishedOrder: [1],
      phase: { type: "await-continuation" },
      table: [{
        attackId: "attack-1",
        attack: { cardId: "club-7", player: 0, actionSequence: 1 },
        defense: { cardId: "club-9", player: 2, actionSequence: 2 }
      }]
    });

    expect(getLegalActions(state, 3)).toEqual([]);
  });

  it("allows a surviving teammate to assist against an enemy in the three-player stage", () => {
    const state = scenario({
      hands: { 0: ["spade-7"], 2: ["diamond-4"], 3: ["club-10"] },
      primaryAttacker: 2,
      defender: 3,
      finishedOrder: [1],
      phase: { type: "await-continuation" },
      table: [{
        attackId: "attack-1",
        attack: { cardId: "club-7", player: 2, actionSequence: 1 },
        defense: { cardId: "club-9", player: 3, actionSequence: 2 }
      }]
    });

    expect(getLegalActions(state, 0)).toEqual([{ type: "request-assist", cardIds: ["spade-7"] }]);
  });

  it("moves a successful defender into attack and skips a failed defender", () => {
    let success = scenario({ hands: { 0: ["club-7", "spade-2"], 1: ["club-9", "spade-3"], 2: ["diamond-4"], 3: ["diamond-5"] } });
    success = apply(success, { type: "play-attack", actor: 0, cardId: "club-7" });
    success = apply(success, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });
    success = apply(success, { type: "stop-attack", actor: 0 });
    expect([success.primaryAttacker, success.defender]).toEqual([1, 2]);

    let failure = scenario({ hands: { 0: ["club-7", "spade-2"], 1: ["club-9"], 2: ["diamond-4"], 3: ["diamond-5"] } });
    failure = apply(failure, { type: "play-attack", actor: 0, cardId: "club-7" });
    failure = apply(failure, { type: "collect-table", actor: 1 });
    expect([failure.primaryAttacker, failure.defender]).toEqual([2, 3]);
    expect(failure.players[1].hand).toContain("club-7");
  });

  it("ends the round immediately after the defender uses their final card", () => {
    let state = scenario({ hands: { 0: ["club-7", "spade-2"], 1: ["club-9"], 2: ["diamond-4"], 3: ["diamond-5"] } });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "club-7" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });

    expect(state.players[1].finishedPlace).toBe(1);
    expect(state.phase.type).toBe("await-opening-attack");
    expect([state.primaryAttacker, state.defender]).toEqual([2, 3]);
    expect(state.table).toEqual([]);
  });
});

describe("refill, finishing, and victory", () => {
  it("refills from the original attacker and gives the last player all remaining cards", () => {
    const seatZero = ["club-7", "spade-2", "spade-3", "spade-4", "spade-5", "spade-6"];
    const seatOne = ["club-9", "club-2", "club-3", "club-4", "club-5", "club-6", "club-8", "club-10"];
    const seatTwo = ["diamond-2", "diamond-3", "diamond-4", "diamond-5", "diamond-6", "diamond-7", "diamond-8"];
    const seatThree = ["heart-3", "heart-4", "heart-5", "heart-6", "heart-7", "heart-8", "heart-9"];
    let state = scenario({
      hands: { 0: seatZero, 1: seatOne, 2: seatTwo, 3: seatThree },
      drawPile: ["diamond-9", "heart-14"]
    });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "club-7" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });
    state = apply(state, { type: "stop-attack", actor: 0 });

    expect(state.players[0].hand).toEqual(expect.arrayContaining(["diamond-9", "heart-14"]));
    expect(state.players[0].hand).toHaveLength(7);
    expect(state.players[1].hand).not.toContain("heart-14");
    expect(state.players[2].hand).toHaveLength(7);
    expect(state.players[3].hand).toHaveLength(7);
    expect(state.drawPile).toEqual([]);
    expect(state.visibleBottomCardId).toBeUndefined();
    expect(state.mainTwoSwap.enabled).toBe(false);
  });

  it("does not finish an empty hand while cards remain to refill", () => {
    let state = scenario({
      hands: { 0: ["club-7"], 1: ["club-9", "spade-3"], 2: ["diamond-4"], 3: ["diamond-5"] },
      drawPile: ["spade-8", "heart-14"]
    });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "club-7" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });
    state = apply(state, { type: "stop-attack", actor: 0 });

    expect(state.players[0].hand).toEqual(["spade-8", "heart-14"]);
    expect(state.players[0].finishedPlace).toBeUndefined();
  });

  it("awards the team when its second player formally finishes", () => {
    let state = scenario({
      hands: { 0: ["club-7"], 1: ["club-9", "spade-3"], 2: [], 3: ["diamond-5"] },
      finishedOrder: [2]
    });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "club-7" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });
    state = apply(state, { type: "stop-attack", actor: 0 });

    expect(state.finishedOrder).toEqual([2, 0]);
    expect(state.winner).toBe(0);
    expect(state.phase.type).toBe("finished");
    expect(getLegalActions(state, 1)).toEqual([]);
  });

  it("uses the previous hand's first finisher as the next hand's first attacker", () => {
    const state = createInitialGame({ rng: seededRandom(1), previousHandFirstFinisher: 3 });
    expect(state.primaryAttacker).toBe(3);
    expect(state.defender).toBe(0);
  });

  it("creates a next hand from a completed hand's first finisher", () => {
    const previous = scenario({
      hands: { 0: [], 1: ["club-3"], 2: [], 3: ["club-4"] },
      finishedOrder: [2, 0]
    });
    previous.phase = { type: "finished" };
    previous.winner = 0;

    const next = createNextHand(previous, seededRandom(9));
    expect(next.handNumber).toBe(2);
    expect(next.primaryAttacker).toBe(2);
  });

  it("skips finished seats when only one player per team remains", () => {
    const state = scenario({
      hands: { 0: ["club-7"], 1: [], 2: [], 3: ["club-9"] },
      primaryAttacker: 0,
      defender: 3,
      finishedOrder: [1, 2]
    });
    expect(state.defender).toBe(3);
    expect(getLegalActions(state, 0)).toEqual([{ type: "play-attack", cardIds: ["club-7"] }]);
  });
});

describe("trump two exchange", () => {
  it("exchanges from an attack window without changing trump suit or pile size", () => {
    let state = scenario({
      hands: { 0: ["heart-2", "club-7"], 1: ["club-9"] },
      drawPile: ["spade-3", "heart-14"]
    });
    state = apply(state, { type: "exchange-trump-two", actor: 0 });

    expect(state.players[0].hand).toContain("heart-14");
    expect(state.players[0].hand).not.toContain("heart-2");
    expect(state.drawPile).toEqual(["spade-3", "heart-2"]);
    expect(state.trumpSuit).toBe("heart");
    expect(state.mainTwoSwap.used).toBe(true);
    expect(state.phase.type).toBe("await-opening-attack");
  });

  it("can exchange before defending and immediately use the received higher trump", () => {
    let state = scenario({
      hands: { 0: [], 1: ["heart-2"] },
      drawPile: ["spade-3", "heart-14"],
      phase: { type: "await-defense", attackId: "attack-1" },
      table: unresolvedAttack("heart-13")
    });
    state = apply(state, { type: "exchange-trump-two", actor: 1 });
    expect(getLegalDefenseCardIds(state)).toEqual(["heart-14"]);
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "heart-14" });
    expect(state.discardPile).toEqual(expect.arrayContaining(["heart-13", "heart-14"]));
  });

  it("offers the collected trump two before refill and permits one global exchange", () => {
    let state = scenario({
      hands: { 0: ["heart-2", "club-4"], 1: ["diamond-9"], 2: ["spade-5"], 3: ["spade-6"] },
      drawPile: ["heart-14"]
    });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "heart-2" });
    state = apply(state, { type: "collect-table", actor: 1 });
    expect(state.phase).toMatchObject({ type: "await-main-two-decision", player: 1, context: "post-collect" });
    state = apply(state, { type: "exchange-trump-two", actor: 1 });
    expect(state.players[1].hand).toContain("heart-14");
    expect(state.mainTwoSwap.used).toBe(true);
    expect(getLegalActions(state, 1)).not.toContainEqual({ type: "exchange-trump-two" });
  });

  it("pauses refill when the trump two is drawn", () => {
    const seatZero = ["club-7", "spade-2", "spade-3", "spade-4", "spade-5", "spade-6", "spade-7", "spade-8"];
    const seatOne = ["club-9", "club-2", "club-3", "club-4", "club-5", "club-6", "club-8", "club-10"];
    let state = scenario({
      hands: { 0: seatZero, 1: seatOne, 2: ["diamond-4"], 3: ["diamond-5"] },
      drawPile: ["heart-2", "diamond-9", "heart-14"]
    });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "club-7" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9" });
    state = apply(state, { type: "stop-attack", actor: 0 });

    expect(state.phase).toMatchObject({ type: "await-main-two-decision", player: 0, context: "draw" });
    expect(state.players[0].hand).toContain("heart-2");
    state = apply(state, { type: "decline-trump-two", actor: 0 });
    expect(state.phase.type).toBe("await-opening-attack");
  });

  it("permanently disables exchange when the trump two reaches the discard pile", () => {
    let state = scenario({
      hands: { 0: ["heart-2", "club-4"], 1: ["heart-3", "club-5"], 2: ["spade-6"], 3: ["spade-7"] },
      drawPile: ["diamond-9", "heart-14"]
    });
    state = apply(state, { type: "play-attack", actor: 0, cardId: "heart-2" });
    state = apply(state, { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "heart-3" });
    state = apply(state, { type: "stop-attack", actor: 0 });

    expect(state.discardPile).toEqual(expect.arrayContaining(["heart-2", "heart-3"]));
    expect(state.mainTwoSwap.enabled).toBe(false);
  });

  it("disables exchange when the initial indicator is the trump two", () => {
    const state = scenario({ hands: { 0: ["club-2"] }, drawPile: ["heart-2"] });
    expect(state.mainTwoSwap.enabled).toBe(false);
    expect(getLegalActions(state, 0)).not.toContainEqual({ type: "exchange-trump-two" });
  });

  it("offers the dealt trump two before the opening attack", () => {
    let state: GameState | undefined;
    for (let seed = 0; seed < 200; seed += 1) {
      const candidate = createInitialGame({ rng: seededRandom(seed) });
      if (candidate.phase.type === "await-main-two-decision") {
        state = candidate;
        break;
      }
    }
    expect(state?.phase).toMatchObject({ type: "await-main-two-decision", context: "deal" });
    if (state?.phase.type !== "await-main-two-decision") return;
    expect(getLegalActions(state, state.phase.player)).toEqual([
      { type: "exchange-trump-two" },
      { type: "decline-trump-two" }
    ]);
  });
});

describe("replay and invariants", () => {
  it("replays a legal command sequence deterministically", () => {
    const initial = scenario({ hands: { 0: ["club-7", "spade-2"], 1: ["club-9", "spade-3"], 2: ["diamond-4"], 3: ["diamond-5"] } });
    const commands: GameCommand[] = [
      { type: "play-attack", actor: 0, cardId: "club-7", expectedRevision: 0 },
      { type: "play-defense", actor: 1, attackId: "attack-1", cardId: "club-9", expectedRevision: 1 },
      { type: "stop-attack", actor: 0, expectedRevision: 2 }
    ];
    const result = replay(initial, commands);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect([result.value.state.primaryAttacker, result.value.state.defender]).toEqual([1, 2]);
    expect(result.value.events.map((event) => event.type)).toEqual([
      "attack-played",
      "defense-played",
      "table-discarded",
      "turn-advanced"
    ]);
  });

  it("preserves all 54 cards throughout arbitrary legal action sequences", () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(fc.nat(), { maxLength: 120 }), (seed, choices) => {
        let state = createInitialGame({ rng: seededRandom(seed) });
        for (const choice of choices) {
          const legalCommands = allLegalCommands(state);
          if (legalCommands.length === 0) break;
          const command = legalCommands[choice % legalCommands.length];
          if (command === undefined) break;
          const result = dispatch(state, command);
          expect(result.ok).toBe(true);
          if (!result.ok) break;
          state = result.value.state;
          const ids = zoneCardIds(state);
          expect(ids).toHaveLength(54);
          expect(new Set(ids)).toHaveLength(54);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("never mutates state for rejected commands", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const state = createInitialGame({ rng: seededRandom(seed) });
        const before = structuredClone(state);
        const result = dispatch(state, {
          type: "collect-table",
          actor: 0,
          expectedRevision: state.revision + 1
        });
        expect(result).toMatchObject({ ok: false, error: { code: "stale-revision" } });
        expect(state).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  it("does not mutate state when a current-revision action is illegal", () => {
    const state = scenario({ hands: { 0: ["club-7"], 1: ["club-9"] } });
    const before = structuredClone(state);
    const result = dispatch(state, {
      type: "play-attack",
      actor: 1,
      cardId: "club-9",
      expectedRevision: state.revision
    });

    expect(result).toMatchObject({ ok: false, error: { code: "not-your-turn" } });
    expect(state).toEqual(before);
  });
});
