import { deviceRows, siteRowsFor } from './support/rows';

const environmentRows = {
  qa: { url: 'https://qa.notes.test' },
  prd: { url: 'https://notes.test' },
};

export default {
  sites: siteRowsFor(['alpha', 'beta']),
  environments: { ...environmentRows },
  devices: deviceRows,
  tags: {
    features: {
      notes: 'the note list, adding and removing a note',
      sharing: 'sharing a note with a guest and revoking the share',
      preview: 'the preview a note shows on hover',
    },
  },
};
