import { expect, type Locator, type Page } from "@playwright/test";

export async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.goto("/");
  await page.getByLabel("你的昵称").fill(nickname);
  await page.getByRole("button", { name: "创建牌桌" }).click();
  await expect(page.getByRole("heading", { name: "四方已摆好，只等人齐" })).toBeVisible();
  return page.locator(".room-code-block strong").innerText();
}

export async function joinRoom(page: Page, nickname: string, roomCode: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("tab", { name: "加入房间" }).click();
  await page.getByLabel("你的昵称").fill(nickname);
  await page.getByLabel("六位房间码").fill(roomCode);
  await page.getByRole("button", { name: "加入牌桌" }).click();
  await expect(page.getByRole("heading", { name: "四方已摆好，只等人齐" })).toBeVisible();
}

export async function readyAndStartBotGame(page: Page): Promise<void> {
  await page.getByRole("button", { name: "我准备好了" }).click();
  await page.getByRole("button", { name: "补满机器人" }).click();
  const start = page.getByRole("button", { name: "开始游戏" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("region", { name: "打八张四人牌桌" })).toBeVisible();
}

export async function actOnCurrentDecision(page: Page): Promise<boolean> {
  try {
    if (await page.getByText("本局结算", { exact: true }).isVisible()) return false;
    const panel = page.getByRole("region", { name: "本次操作" });
    if (await panel.count() === 0 || await panel.getAttribute("aria-busy") === "true") return false;

    if (await clickAvailable(panel.getByRole("button", { name: "拒绝协攻" }))) return true;
    if (await clickAvailable(panel.getByRole("button", { name: "保留主2" }))) return true;
    if (await clickAvailable(panel.getByRole("button", { name: "结束进攻" }))) return true;
    if (await clickAvailable(panel.getByRole("button", { name: "只剩王，跳过进攻" }))) return true;

    const defend = panel.getByRole("button", { name: "用所选牌防守" });
    if (await defend.count() > 0) {
      const card = page.locator(".own-hand .playing-card.is-selectable").first();
      const target = page.getByRole("button", { name: /选择第 \d+ 组作为防守目标/ }).first();
      if (await card.count() > 0 && await target.count() > 0) {
        await card.click();
        await target.click();
        await expect(defend).toBeEnabled();
        await defend.click();
        return true;
      }
      if (await clickAvailable(panel.getByRole("button", { name: "主动收牌" }))) return true;
    }

    const attack = panel.getByRole("button", { name: /^(首攻出牌|追加进攻)$/ });
    if (await attack.count() > 0) {
      const card = page.locator(".own-hand .playing-card.is-selectable").first();
      if (await card.count() > 0) {
        await card.click();
        await expect(attack).toBeEnabled();
        await attack.click();
        return true;
      }
    }

    return await clickAvailable(panel.getByRole("button", { name: "主动收牌" }));
  } catch {
    // Another browser, a bot, or the timeout may advance the authoritative state mid-click.
    return false;
  }
}

export async function driveGameToResult(pages: Page[], timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pages[0]?.getByText("本局结算", { exact: true }).isVisible()) {
      await Promise.all(pages.map((page) => expect(page.getByText("本局结算", { exact: true })).toBeVisible()));
      return;
    }
    let acted = false;
    for (const page of pages) acted = await actOnCurrentDecision(page) || acted;
    if (!acted) await pages[0]?.waitForTimeout(15);
  }
  throw new Error("牌局未在验收时限内完成");
}

async function clickAvailable(locator: Locator): Promise<boolean> {
  if (await locator.count() === 0 || !await locator.isVisible() || !await locator.isEnabled()) return false;
  await locator.click();
  return true;
}
