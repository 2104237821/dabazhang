import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttackPairView, GameViewState, StateSnapshot } from "@dabazhang/protocol";
import {
  GameActionPanel,
  GameDemoScreen,
  GameInteractionScreen,
  GameResultPanel,
  GameRoundStatus
} from "./gameInteraction.js";
import { createInteractionState } from "./gameClient.js";
import type { GameClient, InteractionState } from "./gameClient.js";
import { demoGameScenarios } from "./gameTable.js";

function gameWith(overrides: Partial<GameViewState>): GameViewState {
  return { ...demoGameScenarios["active-round"].game, ...overrides };
}

function stateWith(overrides: Partial<InteractionState>): InteractionState {
  return { ...createInteractionState(18), ...overrides };
}

function uncover(pair: AttackPairView): AttackPairView {
  return { attackId: pair.attackId, attacker: pair.attacker, attack: pair.attack };
}

function snapshot(game: GameViewState): StateSnapshot {
  return {
    revision: game.revision,
    serverTime: 10_000,
    room: {
      roomCode: "BZ8K2Q",
      status: game.phase === "finished" ? "post-game" : "playing",
      hostSeat: 0,
      selfSeat: game.selfSeat,
      players: game.players
    },
    game
  };
}

const idleClient: GameClient = {
  sendCommand: async (command) => ({ requestId: command.requestId, ok: true, revision: 19 })
};

describe("game action panel", () => {
  it("renders opening attack, continuation, stop and assist actions from legalActions", () => {
    const selected = stateWith({ selectedCardId: "self-c7" });
    const opening = gameWith({
      phase: "await-opening-attack",
      legalActions: [{ type: "game:attack", cardIds: ["self-c7"] }]
    });
    const continuation = gameWith({
      phase: "await-continuation",
      legalActions: [
        { type: "game:attack", cardIds: ["self-c7"] },
        { type: "game:assist-propose", cardIds: ["self-c7"] },
        { type: "game:stop-attack" }
      ]
    });

    expect(renderToStaticMarkup(<GameActionPanel game={opening} interaction={selected} onIntent={() => undefined} />))
      .toContain("首攻出牌");
    const continuationHtml = renderToStaticMarkup(
      <GameActionPanel game={continuation} interaction={selected} onIntent={() => undefined} />
    );
    expect(continuationHtml).toContain("追加进攻");
    expect(continuationHtml).toContain("请求队友协攻");
    expect(continuationHtml).toContain("结束进攻");
  });

  it("requires both a selected card and the specified uncovered attack before defense", () => {
    const base = demoGameScenarios["active-round"].game;
    const defense = gameWith({
      phase: "await-defense",
      table: base.table.map((pair) => pair.attackId === "attack-3" ? uncover(pair) : pair),
      legalActions: [{ type: "game:defend", cardIds: ["self-h11"], attackIds: ["attack-3"] }]
    });
    const incomplete = renderToStaticMarkup(
      <GameActionPanel game={defense} interaction={stateWith({ selectedCardId: "self-h11" })} onIntent={() => undefined} />
    );
    const complete = renderToStaticMarkup(
      <GameActionPanel
        game={defense}
        interaction={stateWith({ selectedCardId: "self-h11", selectedAttackId: "attack-3" })}
        onIntent={() => undefined}
      />
    );

    expect(incomplete).toMatch(/>用所选牌防守<\/button>/);
    expect(incomplete).toMatch(/disabled=""[^>]*>用所选牌防守/);
    expect(complete).not.toMatch(/disabled=""[^>]*>用所选牌防守/);
  });

  it("renders take, joker pass, main-two exchange and decline controls", () => {
    const game = gameWith({
      legalActions: [
        { type: "game:take" },
        { type: "game:pass-attack" },
        { type: "game:exchange-trump-two" },
        { type: "game:decline-trump-two" }
      ]
    });
    const html = renderToStaticMarkup(
      <GameActionPanel game={game} interaction={stateWith({})} onIntent={() => undefined} />
    );

    expect(html).toContain("主动收牌");
    expect(html).toContain("只剩王，跳过进攻");
    expect(html).toContain("主2换取底牌");
    expect(html).toContain("保留主2");
  });

  it("shows the sanitized assist proposal only to the approving primary attacker", () => {
    const game = gameWith({
      phase: "await-assist-approval",
      assistProposal: {
        proposalId: "proposal-1",
        proposer: 2,
        card: { cardId: "proposal-card", suit: "diamond", rank: 7, isTrump: false }
      },
      legalActions: [{ type: "game:assist-decide", cardIds: ["proposal-card"], attackIds: ["proposal-1"] }]
    });
    const html = renderToStaticMarkup(
      <GameActionPanel game={game} interaction={stateWith({})} onIntent={() => undefined} />
    );

    expect(html).toContain("南枝请求用方块7协攻");
    expect(html).toContain("同意协攻");
    expect(html).toContain("拒绝协攻");
  });

  it("locks every action while a command is pending and announces the error state", () => {
    const game = gameWith({ legalActions: [{ type: "game:take" }, { type: "game:stop-attack" }] });
    const pending = stateWith({
      submission: { status: "pending", requestId: "request-1", expectedRevision: 18 }
    });
    const error = stateWith({ submission: { status: "error", message: "服务器拒绝了操作" } });
    const pendingHtml = renderToStaticMarkup(
      <GameActionPanel game={game} interaction={pending} onIntent={() => undefined} />
    );
    const errorHtml = renderToStaticMarkup(
      <GameActionPanel game={game} interaction={error} onIntent={() => undefined} />
    );

    expect((pendingHtml.match(/disabled=""/g) ?? [])).toHaveLength(2);
    expect(pendingHtml).toContain("aria-busy=\"true\"");
    expect(pendingHtml).toContain("正在发送操作");
    expect(errorHtml).toContain("role=\"alert\"");
    expect(errorHtml).toContain("服务器拒绝了操作");
  });
});

describe("round and result status", () => {
  it("shows the authoritative 45 second countdown and reconnect notice", () => {
    const game = gameWith({ decisionDeadline: 55_000 });
    const html = renderToStaticMarkup(
      <GameRoundStatus game={game} serverTime={10_000} connectionState="reconnecting" />
    );

    expect(html).toContain("剩余 45 秒");
    expect(html).toContain("正在重连");
    expect(html).toContain("aria-live=\"polite\"");
  });

  it("renders winner, finish order and the play-again command", () => {
    const game = gameWith({
      phase: "finished",
      winner: 0,
      finishedOrder: [0, 2, 1],
      legalActions: []
    });
    const html = renderToStaticMarkup(
      <GameResultPanel game={game} interaction={stateWith({})} onIntent={() => undefined} />
    );

    expect(html).toContain("我方获胜");
    expect(html).toContain("出完顺序");
    expect(html).toContain("大巴掌");
    expect(html).toContain("南枝");
    expect(html).toContain("再来一局");
  });
});

describe("controlled game screen", () => {
  it("renders only the sanitized snapshot and clearly marks demo transport", () => {
    const game = gameWith({ legalActions: [] });
    const html = renderToStaticMarkup(
      <GameInteractionScreen
        snapshot={snapshot(game)}
        client={idleClient}
        modeLabel="本地脱敏演示"
      />
    );

    expect(html).toContain("本地脱敏演示");
    expect(html).toContain("打八张四人牌桌");
    expect(html).toContain("队友南枝的背面手牌");
    expect(html).not.toContain("self-big-joker");
  });

  it("uses the same controlled interaction layer for the clearly labelled demo", () => {
    const html = renderToStaticMarkup(<GameDemoScreen onExit={() => undefined} />);

    expect(html).toContain("本地脱敏演示");
    expect(html).toContain("操作不会发送到服务器");
    expect(html).toContain("追加进攻");
    expect(html).toContain("结束进攻");
  });
});
