import { expect, test } from "./fixtures";

test("a note shared by link opens for a guest", async ({ notes, config }) => {
  test.skip(!config.hasFeature("sharing"), "sharing is not part of this target");
  await notes.share("Buy milk");
  await expect(notes.sharedBanner()).toBeVisible();
});
