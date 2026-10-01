import { expect, test } from "./fixtures";

test("a new note appears in the list", async ({ page, notes }) => {
  await notes.open();
  await page.getByRole("textbox", { name: "New note" }).fill("Buy milk");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(notes.items()).toHaveText(["Buy milk"]);
});
