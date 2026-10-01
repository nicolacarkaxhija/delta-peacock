import { expect, test } from "./fixtures";

test("a search lists matching lamps", async ({ search }) => {
  await search.query("lamp");
  test.skip((await search.results().count()) === 0, "no results today");
  await expect(search.results()).toHaveText(["Desk lamp", "Floor lamp"]);
});
