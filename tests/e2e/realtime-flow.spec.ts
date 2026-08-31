import { expect, test } from "@playwright/test";

import { createRoom, driveGameToResult, joinRoom, readyAndStartBotGame } from "./helpers.js";

test("一名真人与三名机器人完成整局并再来一局", async ({ page }) => {
  const roomCode = await createRoom(page, "单人验收");
  await readyAndStartBotGame(page);
  await expect(page.getByText(`联网房间 ${roomCode}`)).toBeVisible();

  await driveGameToResult([page]);
  await expect(page.getByRole("button", { name: "再来一局" })).toBeVisible();
  await page.getByRole("button", { name: "再来一局" }).click();
  await expect(page.getByText("本局结算", { exact: true })).toBeHidden();
  await expect(page.getByText(`联网房间 ${roomCode}`)).toBeVisible();
});

test("四个独立浏览器完成真人联机牌局", async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    const host = pages[0];
    if (host === undefined) throw new Error("缺少房主页面");
    const roomCode = await createRoom(host, "玩家0");
    for (let seat = 1; seat < pages.length; seat += 1) {
      const page = pages[seat];
      if (page === undefined) throw new Error(`缺少玩家${seat}页面`);
      await joinRoom(page, `玩家${seat}`, roomCode);
    }

    await Promise.all(pages.map((page) => page.getByRole("button", { name: "我准备好了" }).click()));
    const start = host.getByRole("button", { name: "开始游戏" });
    await expect(start).toBeEnabled();
    await start.click();
    await Promise.all(pages.map((page) => expect(page.getByRole("region", { name: "打八张四人牌桌" })).toBeVisible()));

    await driveGameToResult(pages);
    const results = await Promise.all(pages.map((page) => page.locator(".game-result-panel h2").innerText()));
    expect(results.every((result) => /^(我方|对方)获胜$/.test(result))).toBe(true);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

test("刷新和短暂断网后恢复同一座位", async ({ context, page }) => {
  const roomCode = await createRoom(page, "恢复验收");
  await readyAndStartBotGame(page);
  const selfBefore = await page.locator(".game-seat-bottom .game-player-copy strong").innerText();

  await page.reload();
  await expect(page.getByText(`联网房间 ${roomCode}`)).toBeVisible();
  await expect(page.locator(".game-seat-bottom .game-player-copy strong")).toHaveText(selfBefore);

  await context.setOffline(true);
  await expect(page.getByText(/正在重连|连接已断开/).first()).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("服务器已连接")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`联网房间 ${roomCode}`)).toBeVisible();
  await expect(page.locator(".game-seat-bottom .game-player-copy strong")).toHaveText(selfBefore);
});
