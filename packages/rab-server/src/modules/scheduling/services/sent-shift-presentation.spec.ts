import { sentShiftPresentation as view } from './sent-shift-presentation';
const zero = {sent:0,pending:0,accepted:0,confirmed:0,cancelled:0,declined:0,expired:0,withdrawn:0,rejected:0};
it('pending approval cannot imply staff delivery',()=>expect(view('pending_manager_approval',5,zero)).toEqual({statusLabel:'Waiting for manager approval',filters:['pending'],counters:{sent:false,accepted:false,confirmed:false}}));
it('counts one shift, includes confirmed in acceptance, and requires all seats for confirmation',()=>{
 expect(view('partially_filled',5,{...zero,sent:5,pending:3,confirmed:2})).toMatchObject({filters:['pending','staff_accepted'],counters:{sent:true,accepted:true,confirmed:false}});
 expect(view('filled',5,{...zero,sent:5,confirmed:5})).toMatchObject({statusLabel:'Confirmed',filters:['staff_accepted','manager_confirmed'],counters:{sent:true,accepted:true,confirmed:true}});
});
it.each(['cancelled','completed','declined'])('terminal %s excludes active progress filters',status=>{
 const row=view(status,1,{...zero,sent:1,pending:1,confirmed:1});
 expect(row.filters).toEqual([status]); expect(row.counters).toEqual({sent:true,accepted:false,confirmed:false});
});
it('mixed rejection/expiry/withdrawal stays visible in the corresponding filters',()=>{
 expect(view('offered',5,{...zero,sent:5,pending:1,declined:1,expired:1,withdrawn:1,rejected:1}).filters).toEqual(['pending','declined','expired','withdrawn','manager_rejected']);
});
