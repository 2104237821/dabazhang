import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttackPairView, CardView } from "@dabazhang/protocol";
import { AttackPairGrid, Card, GameTable, OpponentHand } from "./gameTableComponents.js";
import {
  demoGameScenarios,
  describeCard,
  getNextCardFocusIndex,
  getSelectableCardIds,
  isRedactedForSelf,
  playerRoleLabel,
  playerStatusLabel,
  rankLabel
} from "./gameTable.js";

function uncover(pair: AttackPairView): AttackPairView {
  return { attackId: pair.attackId, attacker: pair.attacker, attack: pair.attack };
}

describe("card presentation", () => {
  it("creates complete Chinese card labels", () => {
    const trump: CardView = { cardId: "heart-a", suit: "heart", rank: 14, isTrump: true };
    expect(rankLabel(11)).toBe("J");
    expect(rankLabel("bigJoker")).toBe("大王");
    expect(describeCard(trump)).toBe("红桃A，主牌");
  });

  it("renders a selectable trump card with accessible state", () => {
    const trump: CardView = { cardId: "club-2", suit: "club", rank: 2, isTrump: true };
    const html = renderToStaticMarkup(<Card card={trump} interactive selectable selected />);
    expect(html).toContain("aria-label=\"梅花2，主牌，可选择\"");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("trump-corner");
  });

  it("renders opponent hands from a count without card identities", () => {
    const html = renderToStaticMarkup(<OpponentHand count={15} position="left" ownerLabel="队友南枝" />);
    expect(html).toContain("队友南枝的背面手牌，共 15 张");
    expect(html).toContain("+3");
    expect(html).not.toContain("cardId");
  });

  it("describes an attack and its defense as one accessible pair", () => {
    const active = demoGameScenarios["active-round"].game;
    const html = renderToStaticMarkup(<AttackPairGrid pairs={active.table} players={active.players} />);
    expect(html).toContain("role=\"list\"");
    expect(html).toContain("大巴掌用梅花7进攻，已被梅花J防住");
    expect(html).toContain("南枝用方块J进攻，已被红桃4，主牌防住");
  });

  it("renders an explicit selectable target for an uncovered legal defense", () => {
    const active = demoGameScenarios["active-round"].game;
    const pairs = active.table.map((pair) => pair.attackId === "attack-3" ? uncover(pair) : pair);
    const html = renderToStaticMarkup(
      <AttackPairGrid
        pairs={pairs}
        players={active.players}
        defendableAttackIds={new Set(["attack-3"])}
        selectedAttackId="attack-3"
        onSelectDefenseTarget={() => undefined}
      />
    );

    expect(html).toContain("选择第 3 组作为防守目标");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("已选防守目标");
  });
});

describe("keyboard hand navigation", () => {
  it("wraps left and right and supports first/last shortcuts", () => {
    expect(getNextCardFocusIndex(0, "ArrowLeft", 8)).toBe(7);
    expect(getNextCardFocusIndex(7, "ArrowRight", 8)).toBe(0);
    expect(getNextCardFocusIndex(5, "Home", 8)).toBe(0);
    expect(getNextCardFocusIndex(1, "End", 8)).toBe(7);
  });
});

describe("redacted game-view helpers", () => {
  it("keeps card faces only on the self player", () => {
    expect(isRedactedForSelf(demoGameScenarios["active-round"].game)).toBe(true);
    expect(isRedactedForSelf(demoGameScenarios["late-game"].game)).toBe(true);
  });

  it("renders all fixed relative seats without exposing another hand", () => {
    const active = demoGameScenarios["active-round"].game;
    const html = renderToStaticMarkup(<GameTable game={active} selectedCardId={null} onSelectCard={() => undefined} />);
    expect(html).toMatch(/game-seat-bottom[^>]+aria-label="我，大巴掌/);
    expect(html).toMatch(/game-seat-right[^>]+aria-label="下家，临风/);
    expect(html).toMatch(/game-seat-top[^>]+aria-label="对家队友，南枝/);
    expect(html).toMatch(/game-seat-left[^>]+aria-label="上家，北辰/);
    expect(html).toContain("队友南枝的背面手牌");
    expect(html).not.toContain("self-big-joker");
  });

  it("keeps a formally finished player in the same seat", () => {
    const late = demoGameScenarios["late-game"].game;
    const html = renderToStaticMarkup(<GameTable game={late} selectedCardId={null} onSelectCard={() => undefined} />);
    expect(html).toMatch(/game-seat-left[^>]+is-finished[^>]+aria-label="上家，临风，第 1 名出完，已出完/);
    expect(html).toContain("机器人接管");
    expect(html).toContain("离线 · 等待重连");
    expect(html).toContain("牌堆已空");
  });

  it("uses only server-provided legal card ids for selection", () => {
    const selectable = getSelectableCardIds(demoGameScenarios["active-round"].game);
    expect([...selectable].sort()).toEqual(["self-c7", "self-d7", "self-h11"]);
  });

  it("maps player roles and controller states for display", () => {
    const active = demoGameScenarios["active-round"].game;
    expect(playerRoleLabel(active, active.players[0]!)).toBe("主攻");
    expect(playerRoleLabel(active, active.players[1]!)).toBe("防守");
    expect(playerStatusLabel(active.players[2]!)).toBe("机器人玩家");
    expect(playerStatusLabel(active.players[3]!)).toBe("离线 · 等待重连");

    const late = demoGameScenarios["late-game"].game;
    expect(playerStatusLabel(late.players[0]!)).toBe("第 1 名出完");
    expect(playerStatusLabel(late.players[2]!)).toBe("机器人接管");
  });
});
