import { expect, test } from "./fixtures";

test("notes work", async ({ notes, settings }) => {
  await notes.add("Buy milk");
  await expect(notes.items()).toHaveText(["Buy milk"]);
  await settings.switchTheme("dark");
  await expect(settings.theme()).toHaveText("Dark");
});
