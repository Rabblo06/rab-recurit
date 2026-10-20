import { sentShiftPresentation as view } from './sent-shift-presentation';
const zero = {sent:0,pending:0,accepted:0,confirmed:0,cancelled:0,declined:0,expired:0,withdrawn:0,rejected:0};
it('pending approval cannot imply staff delivery',()=>expect(view('pending_manager_approval',5,zero)).toEqual({statusLabel:'Waiting for manager approval',filters:['pending'],actionExpired:false,counters:{sent:false,accepted:false,confirmed:false}}));
it('counts one shift, includes confirmed in acceptance, and requires all seats for confirmation',()=>{
 expect(view('partially_filled',5,{...zero,sent:5,pending:3,confirmed:2})).toMatchObject({filters:['pending','staff_accepted'],actionExpired:false,counters:{sent:true,accepted:true,confirmed:false}});
 expect(view('filled',5,{...zero,sent:5,confirmed:5})).toMatchObject({statusLabel:'Confirmed',filters:['staff_accepted','manager_confirmed'],actionExpired:false,counters:{sent:true,accepted:true,confirmed:true}});
});
it.each(['cancelled','completed','declined'])('terminal %s excludes active progress filters',status=>{
 const row=view(status,1,{...zero,sent:1,pending:1,confirmed:1});
 expect(row.filters).toEqual([status]); expect(row.counters).toEqual({sent:true,accepted:false,confirmed:false});
});
it('mixed rejection/expiry/withdrawal stays visible in the corresponding filters',()=>{
 expect(view('offered',5,{...zero,sent:5,pending:1,declined:1,expired:1,withdrawn:1,rejected:1}).filters).toEqual(['pending','declined','withdrawn','manager_rejected']); // one expired offer among live ones is not an expired request
});

describe('five-hour action window', () => {
  const counts = { sent: 3, pending: 2, accepted: 1, confirmed: 0, cancelled: 0, declined: 0, expired: 0, withdrawn: 0, rejected: 0 };
  it('an expired shift is not presented as pending or accepted and reads Expired', () => {
    const p = view('partially_filled', 3, counts, true);
    expect(p.statusLabel).toBe('Expired');
    expect(p.actionExpired).toBe(true);
    expect(p.filters).toContain('expired');
    expect(p.filters).not.toContain('pending');
    expect(p.filters).not.toContain('staff_accepted');
    expect(p.counters.accepted).toBe(false);
  });
  it('a terminal shift keeps its own label even past the window', () => {
    const p = view('completed', 3, counts, true);
    expect(p.statusLabel).toBe('Completed');
    expect(p.actionExpired).toBe(false);
  });
  it('inside the window nothing changes', () => {
    expect(view('partially_filled', 3, counts, false).statusLabel).toBe('Staff responses received');
  });
});

it('a request whose staff were all no-shows says so instead of "No active offers"', () => {
  const p = view('fully_filled', 2, { sent: 2, pending: 0, accepted: 0, confirmed: 0, noShow: 2, cancelled: 0, declined: 0, expired: 0, withdrawn: 0, rejected: 0 });
  expect(p.statusLabel).toBe('Staff no-show');
});

describe('terminal offer outcomes are named, never relabelled as Expired', () => {
  const zeroN = { ...zero, noShow: 0 };
  it('every offer withdrawn', () => {
    const p = view('offered', 3, { ...zeroN, sent: 3, withdrawn: 3 });
    expect(p.statusLabel).toBe('Offers withdrawn');
    expect(p.filters).toEqual(['withdrawn']);
    expect(p.actionExpired).toBe(false);
  });
  it('every offer rejected by the manager', () => {
    expect(view('offered', 2, { ...zeroN, sent: 2, rejected: 2 }).statusLabel).toBe('Offers rejected');
  });
  it('a mix of withdrawn and expired with nothing active stays "No active offers" and is not Expired', () => {
    const p = view('offered', 3, { ...zeroN, sent: 3, withdrawn: 1, expired: 2 });
    expect(p.statusLabel).toBe('No active offers');
    expect(p.filters).not.toContain('expired');
  });
});
