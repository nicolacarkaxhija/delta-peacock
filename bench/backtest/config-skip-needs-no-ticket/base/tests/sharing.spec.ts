import { expect, test } from './fixtures';

test('a shared note opens for a guest', async ({ notes, settings }) => {
  test.skip(settings.muted('sharingMuted'), 'tenant b drops the share link; muted until 2026-11-20');
  await notes.share('Buy milk');
  await expect(notes.sharedBanner()).toBeVisible();
});

test('a shared note can be revoked', async ({ notes, settings }) => {
  test.skip(settings.muted('sharingMuted'), 'tenant b drops the share link; muted until 2026-11-20');
  await notes.share('Buy milk');
  await notes.revokeShare('Buy milk');
  await expect(notes.sharedBanner()).toBeHidden();
});
