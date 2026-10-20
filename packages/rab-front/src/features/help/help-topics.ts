/**
 * Help Center content. Every topic describes a workflow that exists in this application today (see the linked page) — no
 * policy, duration, price or promise is stated here that the product does not itself enforce. When a workflow changes,
 * update its topic in the same change.
 */
export interface HelpTopic {
  id: string;
  section: 'People' | 'Shifts and offers' | 'Attendance and timesheets' | 'Your account';
  title: string;
  summary: string;
  steps: string[];
  link?: { to: string; label: string };
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'add-staff',
    section: 'People',
    title: 'Add a staff member',
    summary: 'Staff are created from Users and receive an invitation email to set up their account.',
    steps: [
      'Open Users and choose New staff (or Add Staff from your account menu).',
      'Fill in their details and save. They receive an invitation link by email.',
      'Until they accept, their status shows as invited. You can resend the invitation from their detail panel.',
    ],
    link: { to: '/users', label: 'Open Users' },
  },
  {
    id: 'venue-managers',
    section: 'People',
    title: 'Add a venue manager',
    summary: 'Venue managers look after the venues you assign to them and work in the Crewflow mobile app.',
    steps: [
      'Open Users → Venue managers and choose New venue manager (or Add venue manager from your account menu).',
      'Assign them to one of your venues. They receive an invitation email to activate their account.',
      'From their detail panel you can choose which of your staff they can see and select.',
    ],
    link: { to: '/users', label: 'Open Users' },
  },
  {
    id: 'bulk-actions',
    section: 'People',
    title: 'Act on several people at once',
    summary: 'Tick rows in a Users list to activate, deactivate, email or delete them together.',
    steps: [
      'Tick the people you want, or use the box in the header to select everyone on the current page.',
      'Choose an action in the bar at the bottom of the screen. Crewflow shows who it applies to and who will be skipped, and why, before anything changes.',
      'Accounts whose invitation has not been accepted cannot be activated or deactivated; resend the invitation instead.',
      'Deleting asks for your current password. Results are shown per person; anyone that failed stays selected so you can retry.',
    ],
    link: { to: '/users', label: 'Open Users' },
  },
  {
    id: 'create-shift',
    section: 'Shifts and offers',
    title: 'Create a shift and send offers',
    summary: 'A shift belongs to a venue and a job role; staff receive offers and accept them in the mobile app.',
    steps: [
      'Open Shifts and choose New shift. Pick the venue, role, date, times and number of staff needed.',
      'Use Send offer and select the staff who should receive it.',
      'If someone has marked themselves unavailable on that day, Crewflow warns you before sending; you can cancel or send anyway.',
    ],
    link: { to: '/shifts', label: 'Open Shifts' },
  },
  {
    id: 'confirm-offers',
    section: 'Shifts and offers',
    title: 'Confirm accepted offers',
    summary: 'When staff accept an offer it waits for your confirmation before they are booked.',
    steps: [
      'Open Offers and filter by Staff accepted.',
      'Confirm or reject each accepted offer, or use Confirm all accepted for a batch.',
      'Offers that pass their expiry without a response show as expired and are not active.',
    ],
    link: { to: '/offers', label: 'Open Offers' },
  },
  {
    id: 'venue-offers',
    section: 'Shifts and offers',
    title: 'Follow a shift in Venue Offers',
    summary: 'The staffing board shows every person on a shift by stage, from offered to clocked out.',
    steps: [
      'Open Venue Offers and choose a shift to see its staffing board.',
      'The counters at the top match the cards in each lane; choose a counter to jump to that lane.',
      'Approve or decline shift requests from venue managers from the same list.',
    ],
    link: { to: '/venue-offers', label: 'Open Venue Offers' },
  },
  {
    id: 'attendance',
    section: 'Attendance and timesheets',
    title: 'Review attendance',
    summary: 'Staff clock in and out in the mobile app; their times appear on the shift\'s staffing board.',
    steps: [
      'Open the shift in Venue Offers to see who is clocked in, pending review or clocked out.',
      'If someone forgot to clock out, their record waits for review; correct the time and mark it reviewed.',
      'Worked hours and pay appear in Payroll once attendance is complete.',
    ],
    link: { to: '/payroll', label: 'Open Payroll' },
  },
  {
    id: 'timesheets',
    section: 'Attendance and timesheets',
    title: 'Finalise a timesheet',
    summary: 'The timesheet report becomes available when all staff on the shift have clocked out.',
    steps: [
      'In the shift\'s staffing board, choose Timesheet report.',
      'Check the hours, then sign and send it. You can view or download the PDF afterwards.',
    ],
    link: { to: '/venue-offers', label: 'Open Venue Offers' },
  },
  {
    id: 'devices',
    section: 'Your account',
    title: 'See where you are signed in',
    summary: 'Settings → Profile → Devices lists every session that can still use your account.',
    steps: [
      'Open Settings → Profile and scroll to Devices. Your current device is marked "This device".',
      'Use the menu on a row to log out that session, or Log out all other devices to end every session except this one.',
      'To sign out of this device, use Log out in the account menu.',
    ],
    link: { to: '/settings/profile', label: 'Open Profile' },
  },
  {
    id: 'password',
    section: 'Your account',
    title: 'Set or change your password',
    summary: 'Crewflow emails you a secure link to set your password.',
    steps: [
      'Open Settings → Profile → Password & access and choose Set password.',
      'Follow the link in the email. Setting a new password ends your existing sessions, so sign in again with it.',
    ],
    link: { to: '/settings/profile', label: 'Open Profile' },
  },
  {
    id: 'shortcuts',
    section: 'Your account',
    title: 'Add your own sidebar shortcuts',
    summary: 'Use + next to Operations to pin pages, filtered views, records, links or folders to your sidebar.',
    steps: [
      'Choose + next to Operations, pick a type, then search for what you want.',
      'Confirm the name and icon. Shortcuts are saved on this device for your account and workspace.',
      'A shortcut never changes who can see something: if you lose access, opening it shows that it is unavailable.',
    ],
  },
];

export function searchTopics(query: string): HelpTopic[] {
  const q = query.trim().toLowerCase();
  if (!q) return HELP_TOPICS;
  return HELP_TOPICS.filter((t) => [t.title, t.summary, t.section, ...t.steps].join(' ').toLowerCase().includes(q));
}
