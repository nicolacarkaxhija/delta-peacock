import { expect, test } from "./fixtures";

test("the monthly plan shows its price", async ({ pricing }) => {
  await expect(pricing.price("monthly")).toHaveText("9.00");
});

test("the yearly plan shows its price", async ({ pricing }) => {
  await expect(pricing.price("yearly")).toHaveText("90.00");
});
