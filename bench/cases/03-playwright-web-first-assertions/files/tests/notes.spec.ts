import { expect, test } from "./fixtures";

test("a saved note shows a confirmation", async ({ notes }) => {
  await notes.add("Buy milk");
  expect(await notes.status().isVisible()).toBe(true);
});
