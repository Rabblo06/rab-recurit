// One user per screen, distinct IPs: a quick functional check of a schedule against the stack (not a measurement).
const users = [
  { screen: 'vm-sent-shifts-flutter', email: 'venuemanager3@org06.example.test' },
  { screen: 'vm-sent-shifts-ios', email: 'venuemanager2@org06.example.test' },
  { screen: 'staff-home-flutter', email: 'staff20@org06.example.test' },
  { screen: 'staff-job-details-flutter', email: 'staff21@org06.example.test' },
  { screen: 'staff-home-ios', email: 'staff22@org06.example.test' },
  { screen: 'web-venue-offer-pipeline', email: 'manager1@org06.example.test', params: { pipelineShiftId: 'auto' } },
  { screen: 'web-venue-offers', email: 'manager1@org07.example.test' },
  { screen: 'web-bell', email: 'manager2@org07.example.test' },
  { screen: 'web-admin-health', email: 'ceo@org01.example.test' },
];
export default { name: 'smoke', ips: {}, users };
