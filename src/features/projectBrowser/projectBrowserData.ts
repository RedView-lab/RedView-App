export interface ProjectBrowserCard {
  id: string;
  title: string;
  privacyLabel: string;
  savedAt: string;
  sizeLabel: string;
  featured?: boolean;
}

export const PROJECT_BROWSER_PREVIEW_URL =
  'https://www.figma.com/api/mcp/asset/0483f118-7d28-4d59-b465-41ddc56324fa';

export const PROJECT_BROWSER_CARDS: ProjectBrowserCard[] = [
  {
    id: 'project-1-featured',
    title: 'Projet 1',
    privacyLabel: 'Privé',
    savedAt: '20/01/26 à 10:36',
    sizeLabel: '336mo',
    featured: true,
  },
  {
    id: 'project-2',
    title: 'Projet 1',
    privacyLabel: 'Privé',
    savedAt: '20/01/26 à 10:36',
    sizeLabel: '336mo',
  },
  {
    id: 'project-3',
    title: 'Projet 1',
    privacyLabel: 'Privé',
    savedAt: '20/01/26 à 10:36',
    sizeLabel: '336mo',
  },
  {
    id: 'project-4',
    title: 'Projet 1',
    privacyLabel: 'Privé',
    savedAt: '20/01/26 à 10:36',
    sizeLabel: '336mo',
  },
  {
    id: 'project-5',
    title: 'Projet 1',
    privacyLabel: 'Privé',
    savedAt: '20/01/26 à 10:36',
    sizeLabel: '336mo',
  },
  {
    id: 'project-6',
    title: 'Projet 1',
    privacyLabel: 'Privé',
    savedAt: '20/01/26 à 10:36',
    sizeLabel: '336mo',
  },
  {
    id: 'project-7',
    title: 'Projet 1',
    privacyLabel: 'Privé',
    savedAt: '20/01/26 à 10:36',
    sizeLabel: '336mo',
  },
];