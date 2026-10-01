import { getStaffDisplayStatus } from './staffStatus';

describe('getStaffDisplayStatus', () => {
  // TEST 1 / TEST 14 (part 25): the exact regression this helper fixes —
  // a staff member mid-invitation must never read as "Active" just because
  // `employmentStatus` happens to default to 'active' before the account
  // has ever been activated.
  it('derives "Pending invite (n/3)" for a staff member with an open pending invitation, regardless of employmentStatus', () => {
    const result = getStaffDisplayStatus({
      userType: 'staff',
      accountStatus: 'invited',
      employmentStatus: 'active', // the exact trap: this must NOT win
      invitationStatus: 'pending',
      pendingInvite: { sendNumber: 2 },
    });
    expect(result.label).toBe('Pending invite (2/3)');
    expect(result.tone).toBe('pending');
  });

  // TEST 2: a genuinely activated account shows Active.
  it('derives "Active" for a manager whose account is active', () => {
    const result = getStaffDisplayStatus({
      userType: 'manager',
      accountStatus: 'active',
      invitationStatus: null,
      pendingInvite: null,
    });
    expect(result.label).toBe('Active');
    expect(result.tone).toBe('active');
  });

  it('derives the employment status label for a staff member whose account is active', () => {
    const result = getStaffDisplayStatus({
      userType: 'staff',
      accountStatus: 'active',
      employmentStatus: 'inactive',
      invitationStatus: null,
      pendingInvite: null,
    });
    expect(result.label).toBe('inactive');
    expect(result.tone).toBe('inactive');
  });

  // TEST 3: expired invite reads the same regardless of caller, and uses
  // the neutral/grey tone (never the red "cancelled" tone the drawer used
  // to reach for).
  it('derives "Invite expired" with a neutral tone for an expired invitation', () => {
    const result = getStaffDisplayStatus({
      userType: 'staff',
      accountStatus: 'invited',
      invitationStatus: 'expired',
      pendingInvite: null,
    });
    expect(result.label).toBe('Invite expired');
    expect(result.tone).toBe('inactive');
  });

  it('derives the terminal "Expired — cleanup in 7d" label once the account itself has flipped to invite_expired', () => {
    const result = getStaffDisplayStatus({
      userType: 'staff',
      accountStatus: 'invite_expired',
      invitationStatus: 'expired',
      pendingInvite: null,
    });
    expect(result.label).toBe('Expired — cleanup in 7d');
  });

  it('derives a pending state for an invited account with no invite in flight yet', () => {
    const result = getStaffDisplayStatus({
      userType: 'staff',
      accountStatus: 'invited',
      invitationStatus: null,
      pendingInvite: null,
    });
    expect(result.label).toBe('Pending — invite not sent');
    expect(result.tone).toBe('pending');
  });

  it('derives a readable label for a genuinely suspended account with no invite in flight', () => {
    const result = getStaffDisplayStatus({
      userType: 'manager',
      accountStatus: 'suspended',
      invitationStatus: null,
      pendingInvite: null,
    });
    expect(result.label).toBe('Suspended');
    expect(result.tone).toBe('inactive');
  });
});
