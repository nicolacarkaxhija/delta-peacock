import { expect, test } from "./fixtures";

test.fixme("a note shared by link opens for a guest", async ({ notes }) => {
  await notes.share("Buy milk");
  await expect(notes.sharedBanner()).toBeVisible();
});
