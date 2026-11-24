// Synthetic documentation scenarios extending the existing browser fixture backend.
// Never imported by production. No database seed, account, email or AI provider calls.
const {install, APP_ORIGIN}=require('./fixtures.cjs');
const {installAi}=require('./ai-twenty-parity-fixtures.cjs');
async function installUpNext(page,{scenario='populated',ai=true}={}) {
 const fx=await install(page,{persona:'manager',mutate:s=>{s.workspace.name='Demo · Northwind Staffing';}});
 await installAi(page,{conversation:null});
 const iso=hours=>new Date(Date.now()+hours*3600000).toISOString();
 const quiet=scenario==='empty', full=scenario==='fully-staffed';
 const venues=['Willow House','Harbour Rooms','Cedar Hall','Orchard Lodge','Maple Pavilion'];
 const shifts=quiet?[]:venues.map((venueName,i)=>({id:'demo-shift-'+i,venueName,venueId:'demo-venue-'+i,startsAt:iso(4+i*18),endsAt:iso(12+i*18),status:i===0&&!full?'partially_filled':'confirmed',requiredCount:4,filledCount:i===0&&!full?3:4}));
 const offers=quiet||full?[]:['Alex Rowan','Sam Ellis','Robin Ash'].map((staffName,i)=>({id:'demo-offer-'+i,staffName,venueName:venues[i],startsAt:iso(4+i*18),endsAt:iso(12+i*18),status:'staff_accepted',expiresAt:iso(i===0?.75:6+i*18),offerKind:i===2?'replacement':'standard',managerConfirmedAt:null,managerRejectedAt:null}));
 offers.push({...offers[0],id:'expired-hidden',staffName:'Expired synthetic offer',startsAt:iso(8),endsAt:iso(16),status:'staff_accepted',expiresAt:iso(-1)});
 offers.forEach((offer,i)=>Object.assign(offer,{sentAt:iso(-3),staffAcceptedAt:iso(-1),estimatedPayPence:10000,roleName:'Event host',staffProfileId:fx.state.staff[i%fx.state.staff.length].id,shiftId:shifts[i%shifts.length]?.id,offerBatchId:null}));
 fx.state.summaryOverride={activeOfferCount:quiet||full?0:3};
 const requests=quiet||full?[]:[{id:'demo-request',venueName:'Elm Garden',startsAt:iso(22),status:'pending_manager_approval',requiredCount:3,selectedCount:0}];
 if(requests.length){const original=fx.state.shifts.find(s=>s.status==='pending_manager_approval');if(original){requests[0].id=original.id;Object.assign(original,{startsAt:requests[0].startsAt,endsAt:iso(30),requiredCount:3});const venue=fx.state.venues.find(v=>v.id===original.venueId);if(venue)venue.name=requests[0].venueName;}}
 offers.forEach((offer,i)=>{const staff=fx.state.staff[i%fx.state.staff.length];const [firstName,...last]=offer.staffName.split(' ');Object.assign(staff,{firstName,lastName:last.join(' ')});});
 const payroll=quiet||full?[]:[{attendanceId:'demo-review',staffName:'Taylor Brook',venueName:'Willow House',startsAt:iso(-24),attendanceStatus:'under_review',stage:'in_progress',ownHours:false,payrollRecordId:null},{attendanceId:'demo-payroll',staffName:'Casey Vale',venueName:'Harbour Rooms',startsAt:iso(-48),attendanceStatus:'approved',stage:'ready',ownHours:false,payrollRecordId:'demo-record'}];
 payroll.forEach((row,i)=>Object.assign(row,{endsAt:iso(-16-i*24),staffProfileId:fx.state.staff[i].id,staffRef:'DEMO '+(i+1),staffEmail:'demo'+i+'@example.test',staffStatus:'active',roleName:'Event host',workedMinutes:480,payRatePence:1400,amountPence:11200,statement:null,allocation:{status:'unallocated',payrollPeriod:null,payday:null,originalPeriod:null,runId:null,runStatus:null}}));
 const caps=scenario==='restricted'?{}:Object.fromEntries(['schedule.view','venue.view','staff.view','offer.confirm','staffing_request.approve','payroll.view','payroll.approve','attendance.view'].map(k=>[k,true]));
 const headers={'content-type':'application/json','access-control-allow-origin':APP_ORIGIN,'access-control-allow-credentials':'true','access-control-allow-headers':'*'};
 await page.route('**/rest/v1/**',async route=>{
  const url=new URL(route.request().url()),p=url.pathname.replace(/^.*\/rest\/v1/,'');
  let body;
  if(p==='/auth/capabilities')body=caps;
  else if(p==='/shifts')body={data:shifts,total:shifts.length};
  else if(p==='/offers')body={data:offers,total:offers.length};
  else if(p==='/shifts/requests')body={data:requests,total:requests.length};
  else if(p==='/venues')body={data:venues.map((name,i)=>({id:'demo-venue-'+i,name})),total:venues.length};
  else if(p==='/payroll/period')body={month:url.searchParams.get('month'),timezone:'Europe/London',rows:payroll};
  else if(p==='/ai/availability'&&!ai)body={available:false,reason:'feature_disabled',limits:{maxInputChars:4000},usage:null};
  else if(p==='/ai/capabilities')body={tools:['find_shifts','list_unfilled_shifts','get_offer_status','get_timesheet_approval_queue'].map(name=>({name,label:name,summary:'Synthetic demo capability'})),skills:[]};
  else if(p.startsWith('/timeline/shifts/demo-shift-'))body={items:[],nextCursor:null};
  else if(p.startsWith('/shifts/demo-shift-'))body=p.endsWith('/timeline')?{data:[],total:0}:shifts.find(s=>p.endsWith(s.id));
  else return route.fallback();
  if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
  return route.fulfill({status:scenario==='error'&&p==='/shifts'?503:200,headers,body:JSON.stringify(body)});
 });
 // Visible fixture label only in this isolated browser. Closing the isolated browser discards all disposable state.
 await page.addInitScript(()=>{window.addEventListener('DOMContentLoaded',()=>{const tag=document.createElement('div');tag.textContent='SYNTHETIC DEMO · Close to reset · AI responses are not live';tag.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:99999;text-align:center;background:#fff4d8;color:#654b10;font:10px system-ui;padding:4px;pointer-events:none';document.body.append(tag);});});
 return fx;
}
module.exports={installUpNext};
