const siteIds = ['alpha', 'beta'];

export default {
  sites: Object.fromEntries(siteIds.map((id) => [id, { url: `https://${id}.notes.test` }])),
  environments: {
    qa: { url: 'https://qa.notes.test' },
    prd: { url: 'https://notes.test', production: true },
  },
  tags: {
    features: {
      notes: 'the note list, adding and removing a note',
    },
  },
  taxonomy: {
    dimensions: {
      effect: {
        values: { 'sends-mail': 'Sends a mail to a real mailbox' },
      },
    },
  },
};
