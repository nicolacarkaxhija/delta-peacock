import { expect, test } from "./fixtures";

test("an export finishes", async ({ page, reports }) => {
  await reports.startExport();
  await page.waitForTimeout(2000);
  await expect(reports.status()).toHaveText("Ready");
});
