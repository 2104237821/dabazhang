import { describe, expect, it } from "vitest";

import { createInitialGame } from "./deal.js";
import { observeGame } from "./observation.js";

describe("player observation", () => {
  it("reveals only the viewer's hand and never the draw order", () => {
    const state = createInitialGame({ rng: () => 0.25, dealStartSeat: 0, firstAttacker: 0 });
    const observation = observeGame(state, 1);

    expect(observation.players.find((player) => player.seatId === 1)?.hand).toHaveLength(8);
    expect(observation.players.find((player) => player.seatId === 0)?.hand).toBeUndefined();
    expect(observation.players.find((player) => player.seatId === 2)?.hand).toBeUndefined();
    expect(observation).not.toHaveProperty("drawPile");
    expect(observation.drawPileCount).toBe(22);
    expect(observation.bottomCard?.id).toBe(state.originalIndicatorCardId);
  });

  it("reveals a pending assist card only to the primary attacker", () => {
    const state = createInitialGame({ rng: () => 0.25, dealStartSeat: 0, firstAttacker: 0 });
    const proposedCardId = state.players[2].hand[0];
    expect(proposedCardId).toBeDefined();
    state.phase = {
      type: "await-assist-approval",
      proposal: { proposalId: "proposal-1", player: 2, cardId: proposedCardId! }
    };

    expect(observeGame(state, 0).phase).toEqual(state.phase);
    expect(observeGame(state, 1).phase).toEqual({ type: "await-assist-approval" });
    expect(JSON.stringify(observeGame(state, 1))).not.toContain(proposedCardId);
  });
});
