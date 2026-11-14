import { expect, test } from './fixtures';

test('an empty list shows the hint', { tag: ['@notes'] }, async ({ notes }) => {
  await expect(notes.emptyHint()).toBeVisible();
});
