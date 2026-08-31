import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const tableViewports = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 }
] as const;

for (const viewport of tableViewports) {
  test(`确定性牌桌视觉 ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openDemo(page);
    await expect(page).toHaveScreenshot(`table-active-${viewport.width}x${viewport.height}.png`, { fullPage: true });
  });
}

test("协攻、主2、三人阶段、牌堆空与结算视觉状态", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDemo(page);
  for (const scenario of ["协攻审批", "主2换底", "三人阶段", "牌堆已空", "本局结算"] as const) {
    await page.getByRole("button", { name: scenario }).click();
    await expect(page).toHaveScreenshot(`table-${scenario}.png`, { fullPage: true });
  }
});

test("首页、规则抽屉和全部牌桌场景无严重无障碍违规", async ({ page }) => {
  await page.goto("/");
  await expectNoSeriousViolations(page);

  const rulesButton = page.getByRole("button", { name: "游戏规则" });
  await rulesButton.focus();
  await rulesButton.press("Enter");
  await expect(page.getByRole("dialog", { name: "打八张规则" })).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "打八张规则" })).toBeHidden();
  await expect(rulesButton).toBeFocused();

  await openDemo(page);
  for (const scenario of ["攻防进行中", "协攻审批", "主2换底", "三人阶段", "牌堆已空", "本局结算"] as const) {
    await page.getByRole("button", { name: scenario }).click();
    await expectNoSeriousViolations(page);
  }

  await page.getByRole("button", { name: "攻防进行中" }).click();
  const cards = page.locator(".own-hand .playing-card");
  if (await cards.count() > 1) {
    await cards.first().focus();
    await page.keyboard.press("End");
    await expect(cards.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(cards.first()).toBeFocused();
  }
});

test("小于最低尺寸时只显示扩大窗口提示", async ({ page }) => {
  await page.setViewportSize({ width: 1099, height: 649 });
  await page.goto("/");
  await expect(page.getByRole("alertdialog", { name: "需要更大的牌桌" })).toBeVisible();

  await page.setViewportSize({ width: 1100, height: 650 });
  await expect(page.getByRole("alertdialog", { name: "需要更大的牌桌" })).toBeHidden();
});

async function openDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "查看脱敏牌桌演示" }).click();
  await expect(page.getByRole("region", { name: "打八张四人牌桌" })).toBeVisible();
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  expect(serious, serious.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
}
