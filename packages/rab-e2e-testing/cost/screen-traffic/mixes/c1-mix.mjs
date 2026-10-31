// The synthetic user mix for the Phase C1 server-side polling measurement. Identical for the before and the after run
// (only the schedule file changes). All users come from the harness's deterministic seed (seed/seed.js) plus
// seed-screen-traffic.sh (venue requests, one platform admin). Sized for the 4 GB Docker VM next to the dev stack.
//
// ip: the client address the API sees (cf-connecting-ip, trusted only from the harness network). Users with the same
// `ip` share every per-IP limit (the global throttler allows 120 req/min per IP *per route*, MEASURED: the bucket key
// includes the handler): a venue Wi-Fi, carrier NAT, or an office.
// Users without a shared ip get a distinct address each. TEST-NET-3 addresses (203.0.113.0/24) only.

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const p2 = (n) => String(n).padStart(2, '0');
const dom = (o) => `org${p2(o)}.example.test`;

const users = [
  // Venue Manager, Sent Shifts, Flutter: three devices on one Wi-Fi (the throttler buckets per IP AND per route, so three
  // VMs paging GET /offers 5x per refresh exceed 120/min on that route), one on its own connection.
  { screen: 'vm-sent-shifts-flutter', email: `venuemanager1@${dom(1)}`, ip: 'venue-wifi-1' },
  { screen: 'vm-sent-shifts-flutter', email: `venuemanager2@${dom(1)}`, ip: 'venue-wifi-1' },
  { screen: 'vm-sent-shifts-flutter', email: `venuemanager3@${dom(1)}`, ip: 'venue-wifi-1' },
  { screen: 'vm-sent-shifts-flutter', email: `venuemanager1@${dom(4)}` },
  // Venue Manager, Sent Shifts, iOS (schedule DERIVED from Swift): two devices on a second venue Wi-Fi.
  { screen: 'vm-sent-shifts-ios', email: `venuemanager1@${dom(2)}`, ip: 'venue-wifi-2' },
  { screen: 'vm-sent-shifts-ios', email: `venuemanager2@${dom(2)}`, ip: 'venue-wifi-2' },
  // Staff, Flutter Home: five on venue Wi-Fi 1 (with the two VMs), five on their own connection.
  ...range(5, 9).map((i) => ({ screen: 'staff-home-flutter', email: `staff${p2(i)}@${dom(1)}`, ip: 'venue-wifi-1' })),
  ...range(5, 9).map((i) => ({ screen: 'staff-home-flutter', email: `staff${p2(i)}@${dom(3)}` })),
  // Staff, Flutter Job Details open (AppShell + the duplicate ShiftStatusControl poll).
  { screen: 'staff-job-details-flutter', email: `staff10@${dom(1)}`, ip: 'venue-wifi-1' },
  { screen: 'staff-job-details-flutter', email: `staff10@${dom(3)}` },
  { screen: 'staff-job-details-flutter', email: `staff11@${dom(3)}` },
  // Staff, iOS Home (DERIVED): on venue Wi-Fi 2 with the two iOS VMs.
  ...range(5, 8).map((i) => ({ screen: 'staff-home-ios', email: `staff${p2(i)}@${dom(2)}`, ip: 'venue-wifi-2' })),
  // Web console users in one office.
  { screen: 'web-venue-offer-pipeline', email: `manager1@${dom(1)}`, ip: 'office-1', params: { pipelineShiftId: 'auto' } },
  { screen: 'web-venue-offer-pipeline', email: `manager1@${dom(2)}`, ip: 'office-1', params: { pipelineShiftId: 'auto' } },
  { screen: 'web-venue-offers', email: `manager1@${dom(3)}`, ip: 'office-1' },
  { screen: 'web-venue-offers', email: `manager1@${dom(4)}`, ip: 'office-1' },
  { screen: 'web-bell', email: `manager1@${dom(5)}`, ip: 'office-1' },
  { screen: 'web-admin-health', email: `ceo@${dom(1)}`, ip: 'office-1' }, // platform admin (seed-screen-traffic.sh)
];

export default {
  name: 'c1-mix-v2',
  ips: { 'venue-wifi-1': '203.0.113.10', 'venue-wifi-2': '203.0.113.20', 'office-1': '203.0.113.30' },
  users,
};
