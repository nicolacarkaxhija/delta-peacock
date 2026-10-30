export default {
  sites: {
    AL: { locales: { en: { path: '/en' }, nl: { path: '/nl' } } },
    BE: { locales: { de: { path: '/de' } } },
  },
  environments: { qa: { url: 'https://qa.notes.test' }, prd: { url: 'https://notes.test' } },
  tags: {
    features: {
      notes: 'the note list, adding and removing a note',
      sharing: 'sharing a note with a guest and revoking the share',
    },
  },
};
