export type Job = {
  id: string;
  title: string;
  location: string;
  type: string;
  sector: string;
  summary: string;
  active: boolean;
  applyUrl: string;
};
// Historical role examples, NOT verified vacancies. Confirm with a consultant
// before activating any listing. No JobPosting schema is emitted for these.
export const jobs: Job[] = [
  {
    id: 'hospitality-team',
    title: 'Waiting & bar teams',
    location: 'London',
    type: 'Temporary',
    sector: 'Hospitality',
    summary:
      'People who make every welcome count, from hotel dining rooms to special events.',
    active: false,
    applyUrl: '/contact?interest=candidate',
  },
  {
    id: 'kitchen-team',
    title: 'Chefs & kitchen teams',
    location: 'London',
    type: 'Temporary / Permanent',
    sector: 'Catering',
    summary:
      'A place for your craft, whether you are building experience or taking your next step.',
    active: false,
    applyUrl: '/contact?interest=candidate',
  },
  {
    id: 'office-team',
    title: 'Office & professional roles',
    location: 'London',
    type: 'Permanent / Interim',
    sector: 'Office support',
    summary:
      'Bring your organisation, knowledge and ideas to a team that values them.',
    active: false,
    applyUrl: '/contact?interest=candidate',
  },
];
