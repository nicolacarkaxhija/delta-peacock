import { expect, test } from "./fixtures";

test("a guest reads a shared note", { tag: ["@sharing", "@quick"] }, async ({ notes }) => {
  await expect(notes.sharedBanner()).toBeVisible();
});
