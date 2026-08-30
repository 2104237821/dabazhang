import { describe, expect, it } from "vitest";
import type { AttackPairView, ClientCommand, GameViewState } from "@dabazhang/protocol";
import {
  applyCommandAck,
  buildClientCommand,
  createRequestId,
  createInteractionState,
  getDecisionSecondsRemaining,
  getDefendableAttackIds,
  getInteractiveCardIds,
  getPresenceNotice,
  getWinnerSummary,
  isSubmissionLocked,
  makeSubmissionRetryable,
  prepareGameCommand,
  reconcileGameSnapshot,
  selectCard,
  selectDefenseTarget,
  submissionMessage
} from "./gameClient.js";
import type { GameIntent } from "./gameClient.js";
import { demoGameScenarios } from "./gameTable.js";

function withLegalActions(
  legalActions: GameViewState["legalActions"],
  overrides: Partial<GameViewState> = {}
): GameViewState {
  return {
    ...demoGameScenarios["active-round"].game,
    ...overrides,
    legalActions
  };
}

function uncover(pair: AttackPairView): AttackPairView {
  return { attackId: pair.attackId, attacker: pair.attacker, attack: pair.attack };
}

describe("game command adapter", () => {
  const cases: Array<[GameIntent, ClientCommand]> = [
    [
      { type: "game:attack", cardId: "card-a" },
      { requestId: "request-1", expectedRevision: 18, type: "game:attack", payload: { cardId: "card-a" } }
    ],
    [
      { type: "game:pass-attack" },
      { requestId: "request-1", expectedRevision: 18, type: "game:pass-attack", payload: {} }
    ],
    [
      { type: "game:defend", attackId: "attack-2", cardId: "card-b" },
      { requestId: "request-1", expectedRevision: 18, type: "game:defend", payload: { attackId: "attack-2", cardId: "card-b" } }
    ],
    [
      { type: "game:take" },
      { requestId: "request-1", expectedRevision: 18, type: "game:take", payload: {} }
    ],
    [
      { type: "game:stop-attack" },
      { requestId: "request-1", expectedRevision: 18, type: "game:stop-attack", payload: {} }
    ],
    [
      { type: "game:assist-propose", cardId: "card-c" },
      { requestId: "request-1", expectedRevision: 18, type: "game:assist-propose", payload: { cardId: "card-c" } }
    ],
    [
      { type: "game:assist-decide", proposalId: "proposal-1", accepted: true },
      { requestId: "request-1", expectedRevision: 18, type: "game:assist-decide", payload: { proposalId: "proposal-1", accepted: true } }
    ],
    [
      { type: "game:exchange-trump-two" },
      { requestId: "request-1", expectedRevision: 18, type: "game:exchange-trump-two", payload: {} }
    ],
    [
      { type: "game:decline-trump-two" },
      { requestId: "request-1", expectedRevision: 18, type: "game:decline-trump-two", payload: {} }
    ],
    [
      { type: "match:play-again" },
      { requestId: "request-1", type: "match:play-again", payload: {} }
    ]
  ];

  it.each(cases)("builds %s with the protocol payload", (intent, expected) => {
    expect(buildClientCommand(intent, 18, "request-1")).toEqual(expected);
  });

  it("creates an RFC 4122 request id when randomUUID is unavailable on local HTTP", () => {
    const id = createRequestId({
      getRandomValues(array) {
        array.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return array;
      }
    });

    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("exposes only playable own-card ids and uncovered defense targets", () => {
    const base = demoGameScenarios["active-round"].game;
    const game = withLegalActions(
      [
        { type: "game:attack", cardIds: ["attack-card"] },
        { type: "game:defend", cardIds: ["defense-card"], attackIds: ["attack-3"] },
        { type: "game:assist-propose", cardIds: ["assist-card"] },
        { type: "game:assist-decide", cardIds: ["public-proposal-card"], attackIds: ["proposal-1"] }
      ],
      { table: base.table.map((pair) => pair.attackId === "attack-3" ? uncover(pair) : pair) }
    );

    expect([...getInteractiveCardIds(game)].sort()).toEqual(["assist-card", "attack-card", "defense-card"]);
    expect([...getDefendableAttackIds(game)]).toEqual(["attack-3"]);
  });

  it("rejects an illegal card without creating a command", () => {
    const game = withLegalActions([{ type: "game:attack", cardIds: ["legal-card"] }]);
    const result = prepareGameCommand(
      game,
      createInteractionState(game.revision),
      { type: "game:attack", cardId: "forged-card" },
      "request-1"
    );

    expect(result.command).toBeUndefined();
    expect(result.state.submission.status).toBe("error");
    expect(submissionMessage(result.state.submission)).toContain("当前操作不合法");
  });

  it("rejects a command prepared from an old revision", () => {
    const game = withLegalActions([{ type: "game:attack", cardIds: ["legal-card"] }]);
    const result = prepareGameCommand(
      game,
      createInteractionState(game.revision - 1),
      { type: "game:attack", cardId: "legal-card" },
      "request-1"
    );

    expect(result.command).toBeUndefined();
    expect(submissionMessage(result.state.submission)).toContain("牌桌状态已更新");
  });

  it("locks duplicate submissions until a newer snapshot arrives", () => {
    const game = withLegalActions([{ type: "game:attack", cardIds: ["legal-card"] }]);
    const first = prepareGameCommand(
      game,
      createInteractionState(game.revision),
      { type: "game:attack", cardId: "legal-card" },
      "request-1"
    );
    const duplicate = prepareGameCommand(
      game,
      first.state,
      { type: "game:attack", cardId: "legal-card" },
      "request-2"
    );

    expect(first.command?.requestId).toBe("request-1");
    expect(isSubmissionLocked(first.state.submission)).toBe(true);
    expect(duplicate.command).toBeUndefined();
    expect(duplicate.state).toBe(first.state);

    const acknowledged = applyCommandAck(first.state, { requestId: "request-1", ok: true, revision: 19 });
    expect(acknowledged.submission.status).toBe("acknowledged");
    expect(isSubmissionLocked(acknowledged.submission)).toBe(true);

    const sameRevision = reconcileGameSnapshot(acknowledged, game);
    expect(sameRevision.submission.status).toBe("idle");
    expect(sameRevision.revision).toBe(18);

    const refreshed = reconcileGameSnapshot(acknowledged, { ...game, revision: 19 });
    expect(refreshed.submission.status).toBe("idle");
    expect(refreshed.revision).toBe(19);
  });

  it("surfaces server errors and unlocks the controls", () => {
    const game = withLegalActions([{ type: "game:take" }]);
    const pending = prepareGameCommand(
      game,
      createInteractionState(game.revision),
      { type: "game:take" },
      "request-1"
    ).state;
    const failed = applyCommandAck(pending, {
      requestId: "request-1",
      ok: false,
      error: { code: "STALE_REVISION", message: "操作版本已过期" }
    });

    expect(failed.submission.status).toBe("error");
    expect(isSubmissionLocked(failed.submission)).toBe(false);
    expect(submissionMessage(failed.submission)).toBe("操作版本已过期");
  });

  it("turns a locked request into a retryable error without accepting a stale revision", () => {
    const pending = {
      ...createInteractionState(20),
      submission: { status: "pending", requestId: "request-1", expectedRevision: 20 } as const
    };
    const interrupted = makeSubmissionRetryable(pending, "连接已中断");

    expect(interrupted.submission).toEqual({
      status: "error",
      requestId: "request-1",
      message: "连接已中断"
    });
    expect(reconcileGameSnapshot(interrupted, withLegalActions([], { revision: 19 }))).toBe(interrupted);
  });
});

describe("interaction state", () => {
  it("only selects legal cards and legal uncovered attack targets", () => {
    const base = demoGameScenarios["active-round"].game;
    const game = withLegalActions(
      [{ type: "game:defend", cardIds: ["self-h11"], attackIds: ["attack-3"] }],
      { table: base.table.map((pair) => pair.attackId === "attack-3" ? uncover(pair) : pair) }
    );
    const initial = createInteractionState(game.revision);
    const illegalCard = selectCard(initial, game, "self-s4");
    const selectedCard = selectCard(initial, game, "self-h11");
    const illegalTarget = selectDefenseTarget(selectedCard, game, "attack-1");
    const selectedTarget = selectDefenseTarget(selectedCard, game, "attack-3");

    expect(illegalCard).toBe(initial);
    expect(selectedCard.selectedCardId).toBe("self-h11");
    expect(illegalTarget).toBe(selectedCard);
    expect(selectedTarget.selectedAttackId).toBe("attack-3");
  });

  it("clears stale card and attack selections on a newer revision", () => {
    const base = demoGameScenarios["active-round"].game;
    const game = withLegalActions(
      [{ type: "game:defend", cardIds: ["self-h11"], attackIds: ["attack-3"] }],
      { table: base.table.map((pair) => pair.attackId === "attack-3" ? uncover(pair) : pair) }
    );
    const selected = selectDefenseTarget(selectCard(createInteractionState(18), game, "self-h11"), game, "attack-3");
    const refreshed = reconcileGameSnapshot(selected, { ...game, revision: 19 });

    expect(refreshed.selectedCardId).toBeUndefined();
    expect(refreshed.selectedAttackId).toBeUndefined();
  });
});

describe("status presentation", () => {
  it("rounds the 45 second deadline up and never goes below zero", () => {
    expect(getDecisionSecondsRemaining(55_001, 10_000)).toBe(46);
    expect(getDecisionSecondsRemaining(55_000, 10_000)).toBe(45);
    expect(getDecisionSecondsRemaining(9_999, 10_000)).toBe(0);
  });

  it("describes reconnecting and takeover states", () => {
    const game = demoGameScenarios["late-game"].game;
    expect(getPresenceNotice(game, "reconnecting")).toContain("正在重连");
    expect(getPresenceNotice(game, "connected")).toContain("机器人接管");
  });

  it("announces the winning team relative to the current player", () => {
    const game = withLegalActions([], { phase: "finished", winner: 0 });
    expect(getWinnerSummary(game)).toEqual({ title: "我方获胜", detail: "蓝队两名队友已经正式出完" });
    expect(getWinnerSummary({ ...game, winner: 1 })).toEqual({ title: "对方获胜", detail: "铜队两名队友已经正式出完" });
  });
});
