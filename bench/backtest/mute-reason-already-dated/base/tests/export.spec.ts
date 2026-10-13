import { expect, test } from './fixtures';

test('an exported note keeps its title', async ({ notes }) => {
  await notes.create('Buy milk');
  const file = await notes.export('Buy milk');
  expect(file.title).toBe('Buy milk');
});
