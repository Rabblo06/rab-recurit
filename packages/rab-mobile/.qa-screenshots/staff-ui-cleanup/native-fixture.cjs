// Disposable native QA only. Uses production identity factory, services and HTTP guards.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../../../..');
// Target the app's LOCAL Docker environment, never the repository's remote .env.
const container=JSON.parse(require('child_process').execFileSync('docker',['inspect','rab-server-1'],{encoding:'utf8'}))[0];
for(const entry of container.Config.Env){const i=entry.indexOf('=');process.env[entry.slice(0,i)]=entry.slice(i+1);}
for(const key of ['DATABASE_URL','DATABASE_URL_UNPOOLED']){
  if(!process.env[key])throw Error('Local container missing '+key);
  const u=new URL(process.env[key]);
  if(!['postgres','rab-postgres-1','localhost','127.0.0.1'].includes(u.hostname))throw Error('Refusing non-local database');
  u.hostname='127.0.0.1';u.port='55432';process.env[key]=u.toString();
}
require('ts-node').register({project:path.join(root,'packages/rab-server/tsconfig.spec.json'),transpileOnly:true});
require('reflect-metadata');
const src = path.join(root, 'packages/rab-server/src');
const { DataSource } = require('typeorm');
const { coreDataSourceOptions } = require(src+'/database/typeorm/core/core.datasource');
const { TenantContextService } = require(src+'/engine/core-modules/tenant/tenant-context.service');
const { PasswordHashingService } = require(src+'/engine/core-modules/auth/services/password-hashing.service');
const { TestIdentityFactory } = require(src+'/__tests__/integration/helpers/test-identities');
const secretPath = path.join(__dirname,'.qa-session.json');
let session = fs.existsSync(secretPath) ? JSON.parse(fs.readFileSync(secretPath)) : {};
const save = () => fs.writeFileSync(secretPath,JSON.stringify(session,null,2));
const context = () => ({organisationId:session.org.id,workspaceId:session.im.workspaceId,userId:session.im.userId,role:''});
async function api(token, route, body) {
  const response = await fetch('http://127.0.0.1:3000/rest/v1'+route, {
    method:body===undefined?'GET':'POST', headers:{'Content-Type':'application/json','x-client-platform':'mobile',...(token?{Authorization:'Bearer '+token}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const value=await response.json();
  if(!response.ok) throw Error(route+': '+response.status+' '+JSON.stringify(value.message));
  return value;
}
async function login(actor) { return (await api(null,'/auth/login',{email:actor.email,password:actor.password,...(actor.kind==='internal_manager'?{applicationTarget:'manager_web'}:{})})).accessToken; }
async function main() {
  const db = await new DataSource({...coreDataSourceOptions,logging:false,logger:undefined}).initialize();
  const owner = await new DataSource({...coreDataSourceOptions,url:process.env.DATABASE_URL_UNPOOLED,logging:false,logger:undefined}).initialize();
  const tenant = new TenantContextService(db);
  try {
    if(process.argv[2]==='setup') {
      if(session.org) throw Error('Fixture already exists; do not create duplicates.');
      const password=crypto.randomBytes(20).toString('hex');
      const hasher=new PasswordHashingService();
      const factory=new TestIdentityFactory({dataSource:db,adminDataSource:owner,tenantContext:tenant,passwordHashing:{hash:()=>hasher.hash(password)}});
      session.org=await factory.createOrganisation('native-ui-qa'); save();
      session.im=await factory.createInternalManager(session.org,{label:'qa-owner'});session.im.password=password;save();
      session.staff=await factory.createStaff(session.org,{owner:session.im,label:'qa-staff'});session.staff.password=password;save();
      const imToken=await login(session.im);
      session.venue=await api(imToken,'/venues',{name:'Disposable Native QA Hotel',type:'hotel',lat:51.508,lng:-0.1281,geofenceRadiusM:100,enforceGeofence:true});save();
      session.job=await api(imToken,'/job-roles',{name:'QA Bartender',defaultRatePence:1500});save();
      session.vm=await factory.createVenueManager(session.org,{owner:session.im,venueIds:[session.venue.id],label:'qa-venue'});session.vm.password=password;save();
      const vmToken=await login(session.vm);
      await api(vmToken,'/staff/venue-directory/team/'+session.staff.profileId,{});
      const start=new Date(new Date().setUTCHours(32,0,0,0));
      session.shift=await api(vmToken,'/shifts/request',{venueId:session.venue.id,jobRoleId:session.job.id,startsAt:start.toISOString(),endsAt:new Date(start.getTime()+2*3600000).toISOString(),staffRequired:1,staffProfileIds:[session.staff.profileId],breakMinutes:0});save();
      await api(imToken,'/shifts/'+session.shift.id+'/approve',{});
      const staffToken=await login(session.staff);
      const offers=await api(staffToken,'/offers/mine');
      session.offer=(offers.data??offers).find(o=>o.shiftId===session.shift.id);
      if(!session.offer) throw Error('Dedicated shift offer missing');
      await api(staffToken,'/offers/'+session.offer.id+'/accept',{});save();
    }
    if(!session.shift) throw Error('Setup incomplete');
    if(['today','note','age2','age6','qr'].includes(process.argv[2])) {
      if(!session.org.slug.startsWith('native-ui-qa-'))throw Error('Not QA');
      await tenant.runInTenantContext(context(),async m=>{
        const [s]=await m.query('SELECT * FROM core.shift WHERE id=$1 AND organisation_id=$2 AND workspace_id=$3',[session.shift.id,session.org.id,session.im.workspaceId]);
        if(!s||s.venue_id!==session.venue.id)throw Error('QA identity mismatch');
        if(process.argv[2]==='today')await m.query("UPDATE core.shift SET starts_at=now()-interval '1 minute',ends_at=now()+interval '8 hours' WHERE id=$1 AND organisation_id=$2",[s.id,session.org.id]);
        if(process.argv[2]==='note')await m.query('UPDATE core.shift SET notes=$1 WHERE id=$2 AND organisation_id=$3',['Please use the QA staff entrance.',s.id,session.org.id]);
        if(process.argv[2].startsWith('age')) {
          const [a]=await m.query('SELECT * FROM core.attendance WHERE shift_id=$1 AND staff_profile_id=$2',[s.id,session.staff.profileId]);
          if(!a?.clock_out_at)throw Error('No completed QA attendance');
          const hours=process.argv[2]==='age2'?2:6;
          await m.query("UPDATE core.attendance SET clock_in_at=now()-make_interval(hours=>$1)-interval '1 minute',clock_out_at=now()-make_interval(hours=>$1) WHERE id=$2 AND organisation_id=$3",[hours,a.id,session.org.id]);
        }
        const [fresh]=await m.query('SELECT * FROM core.shift WHERE id=$1',[s.id]);
        if(process.argv[2]==='qr'||process.argv[2]==='today') {
          const {JwtService}=require('@nestjs/jwt');
          const {QrTokenService}=require(src+'/modules/attendance/services/qr-token.service');
          const {AttendanceQrService}=require(src+'/modules/attendance/services/attendance-qr.service');
          const env={get:key=>process.env[key]??({CLOCK_IN_EARLY_MINUTES:15,QR_POST_SHIFT_GRACE_MINUTES:120})[key]};
          const signer=new QrTokenService(new JwtService(),env),qr=new AttendanceQrService(signer,env);
          session.qr=qr.sign({id:fresh.id,venueId:fresh.venue_id,qrVersion:fresh.qr_version,startsAt:new Date(fresh.starts_at),endsAt:new Date(fresh.ends_at)});
          const payload=signer.verify(session.qr);
          if(payload.shiftId!==fresh.id||payload.venueId!==fresh.venue_id||payload.ver!==fresh.qr_version)throw Error('QR mismatch');
          await qr.validateQr(m,fresh.id,session.qr);save();
          await require('qrcode').toFile(path.join(__dirname,'.qa-qr.png'),session.qr,{width:1024,margin:4,errorCorrectionLevel:'M'});
        }
      });
      const offers=await api(await login(session.staff),'/offers/mine');
      const current=offers.find(o=>o.shiftId===session.shift.id);
      fs.writeFileSync(path.join(__dirname,'projection-'+process.argv[2]+'.json'),JSON.stringify({shiftId:current.shiftId,presentation:current.presentation},null,2));
      console.log(JSON.stringify({shiftId:current.shiftId,presentation:current.presentation},null,2));return;
    }
    if(process.argv[2]==='clocked-out-ui') {
      if(!session.org.slug.startsWith('native-ui-qa-'))throw Error('Not QA');
      const {JwtService}=require('@nestjs/jwt');
      const {QrTokenService}=require(src+'/modules/attendance/services/qr-token.service');
      const signer=new QrTokenService(new JwtService(),{get:key=>process.env[key]});
      const payload=signer.verify(session.qr);
      await tenant.runInTenantContext(context(),async m=>{
        const [s]=await m.query('SELECT * FROM core.shift WHERE id=$1 AND organisation_id=$2 AND workspace_id=$3',[session.shift.id,session.org.id,session.im.workspaceId]);
        if(!s||payload.shiftId!==s.id||payload.venueId!==s.venue_id||payload.ver!==s.qr_version)throw Error('QR mismatch');
      });
      const token=await login(session.staff);
      await api(token,'/attendance/clock-in',{shiftId:session.shift.id,qrToken:session.qr,lat:51.508,lng:-0.1281,accuracyM:5});
      const result=await api(token,'/attendance/clock-out',{qrToken:session.qr,lat:51.508,lng:-0.1281,accuracyM:5});
      console.log(JSON.stringify({shiftId:result.shiftId,status:result.status,clockOutAt:result.clockOutAt}));
      return;
    }
    if(process.argv[2]==='complete-colour-fixtures'){
      if(!session.org.slug.startsWith('native-ui-qa-')||session.colourShifts?.length!==5)throw Error('Not the five disposable QA fixtures');
      const {JwtService}=require('@nestjs/jwt');
      const {QrTokenService}=require(src+'/modules/attendance/services/qr-token.service');
      const {AttendanceQrService}=require(src+'/modules/attendance/services/attendance-qr.service');
      const env={get:key=>process.env[key]??({CLOCK_IN_EARLY_MINUTES:15,QR_POST_SHIFT_GRACE_MINUTES:120})[key]};
      const signer=new QrTokenService(new JwtService(),env);
      const qr=new AttendanceQrService(signer,env);
      const token=await login(session.staff);
      const results=[];
      for(const fixture of session.colourShifts){
        const shift=await tenant.runInTenantContext(context(),async m=>{
          const [s]=await m.query('SELECT * FROM core.shift WHERE id=$1 AND organisation_id=$2 AND workspace_id=$3',[fixture.id,session.org.id,session.im.workspaceId]);
          if(!s||s.venue_id!==session.venue.id)throw Error('Fixture identity mismatch');
          const [assignment]=await m.query('SELECT * FROM core.shift_assignment WHERE shift_id=$1 AND staff_profile_id=$2',[s.id,session.staff.profileId]);
          if(assignment?.status==='completed')return null;
          if(assignment?.status!=='confirmed'||s.status!=='fully_filled')throw Error('Unexpected fixture state');
          // Fixture scheduling only. Attendance and state transitions remain API-owned.
          const [[updated]]=await m.query("UPDATE core.shift SET starts_at=now()-interval '1 minute',ends_at=now()+interval '1 hour' WHERE id=$1 AND organisation_id=$2 AND workspace_id=$3 RETURNING *",[s.id,session.org.id,session.im.workspaceId]);
          return updated;
        });
        if(!shift)continue;
        console.log(JSON.stringify({shiftId:shift.id,startsAt:shift.starts_at,endsAt:shift.ends_at}));
        const qrToken=qr.sign({id:shift.id,venueId:shift.venue_id,qrVersion:shift.qr_version,startsAt:new Date(shift.starts_at),endsAt:new Date(shift.ends_at)});
        const payload=signer.verify(qrToken);
        if(payload.shiftId!==shift.id||payload.venueId!==session.venue.id||payload.ver!==shift.qr_version)throw Error('QR identity mismatch');
        await tenant.runInTenantContext(context(),m=>qr.validateQr(m,shift.id,qrToken));
        await api(token,'/attendance/clock-in',{shiftId:shift.id,qrToken,lat:51.508,lng:-0.1281,accuracyM:5});
        const completed=await api(token,'/attendance/clock-out',{qrToken,lat:51.508,lng:-0.1281,accuracyM:5});
        results.push({shiftId:shift.id,attendanceId:completed.id,status:completed.status});
      }
      const history=await api(token,'/attendance/me/history');
      const proof=(history.data??history).map(r=>({shiftId:r.shiftId,id:r.id,status:r.status}));
      fs.writeFileSync(path.join(__dirname,'history-proof.json'),JSON.stringify(proof,null,2));
      console.log(JSON.stringify(proof,null,2));return;
    }
    if(process.argv[2]==='cleanup'){
      if(!session.org.slug.startsWith('native-ui-qa-'))throw Error('Not a disposable QA organisation');
      const userIds=[session.im.userId,session.staff.userId,session.vm.userId];
      await tenant.runInTenantContext(context(),async m=>{
        const users=await m.query('SELECT id FROM core."user" WHERE organisation_id=$1',[session.org.id]);
        if(users.length!==3||users.some(u=>!userIds.includes(u.id)))throw Error('Unexpected tenant contents; refuse cleanup');
        const active=await m.query('SELECT id FROM core.attendance WHERE organisation_id=$1 AND clock_out_at IS NULL',[session.org.id]);
        if(active.length)throw Error('QA attendance still active; refuse cleanup');
      });
      const cleanupToken=await login(session.im); for(const record of (session.colourShifts??[session.shift,session.extraUpcoming,session.upcoming].filter(Boolean))) { const [row]=await tenant.runInTenantContext(context(),m=>m.query('SELECT status FROM core.shift WHERE id=$1',[record.id])); if(!['completed','cancelled'].includes(row.status)) await api(cleanupToken,'/shifts/'+record.id+'/cancel',{reason:'Disposable colour UI QA completed'}); }
      const cleanup=await tenant.runInTenantContext(context(),async m=>{
        await m.query('UPDATE core.refresh_token SET revoked_at=now() WHERE organisation_id=$1 AND user_id=ANY($2::uuid[]) AND revoked_at IS NULL',[session.org.id,userIds]);
        const users=await m.query('UPDATE core."user" SET status=$3,password_hash=NULL,temporary_password_hash=NULL,updated_at=now() WHERE organisation_id=$1 AND id=ANY($2::uuid[]) RETURNING id,status',[session.org.id,userIds,'deactivated']);
        await m.query('UPDATE core.staff_profile SET employment_status=$3 WHERE organisation_id=$1 AND id=$2',[session.org.id,session.staff.profileId,'inactive']);
        const tokens=await m.query('SELECT count(*)::int AS count FROM core.refresh_token WHERE organisation_id=$1 AND revoked_at IS NULL',[session.org.id]);
        const shifts=await m.query('SELECT id,status FROM core.shift WHERE organisation_id=$1',[session.org.id]);
        return {organisationId:session.org.id,workspaceId:session.im.workspaceId,users,unrevokedRefreshTokens:tokens[0].count,shifts,retained:'QA organisation/workspace, venue, profiles, completed shifts, assignments, real clocked-out attendance and immutable audit history retained. No hard deletion or RLS changes.'};
      });
      fs.writeFileSync(path.join(__dirname,'cleanup-proof.json'),JSON.stringify(cleanup,null,2));
      console.log(JSON.stringify(cleanup,null,2));return;
    }
    if(process.argv[2]==='report'){
      const report=await api(await login(session.vm),'/attendance/report/shift/'+session.shift.id);
      fs.writeFileSync(path.join(__dirname,'qa-report-response.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify(report,null,2));
      return;
    }
    if(process.argv[2]==='five'){
      session.colourShifts??=[session.shift];save();
      const vmToken=await login(session.vm),imToken=await login(session.im),staffToken=await login(session.staff);
      for(let i=session.colourShifts.length;i<5;i++){
        const start=new Date(new Date(session.shift.startsAt).getTime()+i*2*3600000);
        const shift=await api(vmToken,'/shifts/request',{venueId:session.venue.id,jobRoleId:session.job.id,startsAt:start.toISOString(),endsAt:new Date(start.getTime()+2*3600000).toISOString(),staffRequired:1,staffProfileIds:[session.staff.profileId],breakMinutes:0});
        session.colourShifts.push(shift);save();
        await api(imToken,'/shifts/'+shift.id+'/approve',{});
        const offers=await api(staffToken,'/offers/mine');const offer=(offers.data??offers).find(o=>o.shiftId===shift.id);
        await api(staffToken,'/offers/'+offer.id+'/accept',{});
      }
      const matrix=session.colourShifts.map(s=>{let h=0;for(const c of s.id)h=(h*31+c.charCodeAt(0))%2147483647;return {shiftId:s.id,startsAt:s.startsAt,preferredColour:['lavender','yellow','peach','mint','blue'][h%5]}});
      fs.writeFileSync(path.join(__dirname,'colour-matrix.json'),JSON.stringify(matrix,null,2));
    }
    if(process.argv[2]==='upcoming'){

      if(session.upcoming)throw Error('Upcoming fixture already exists');
      const vmToken=await login(session.vm), imToken=await login(session.im), staffToken=await login(session.staff);
      const start=new Date(Date.now()+(session.extraUpcoming?48:24)*3600000);
      session.upcoming=await api(vmToken,'/shifts/request',{venueId:session.venue.id,jobRoleId:session.job.id,startsAt:start.toISOString(),endsAt:new Date(start.getTime()+2*3600000).toISOString(),staffRequired:1,staffProfileIds:[session.staff.profileId],breakMinutes:0});save();
      await api(imToken,'/shifts/'+session.upcoming.id+'/approve',{});
      const offers=await api(staffToken,'/offers/mine');
      const offer=(offers.data??offers).find(o=>o.shiftId===session.upcoming.id);
      await api(staffToken,'/offers/'+offer.id+'/accept',{});
    }
    const proof=await tenant.runInTenantContext(context(),async m=>{
      const [s]=await m.query('SELECT id,organisation_id,workspace_id,venue_id,qr_version,starts_at,ends_at,status FROM core.shift WHERE id=$1',[session.shift.id]);
      const [v]=await m.query('SELECT id,organisation_id,workspace_id,lat,lng,geofence_radius_m,enforce_geofence FROM core.venue WHERE id=$1',[session.venue.id]);
      const assignments=await m.query('SELECT id,organisation_id,workspace_id,shift_id,staff_profile_id,status FROM core.shift_assignment WHERE shift_id=$1',[session.shift.id]);
      const attendance=await m.query('SELECT id,organisation_id,workspace_id,shift_id,staff_profile_id,status,clock_in_at,clock_out_at,worked_minutes FROM core.attendance WHERE shift_id=$1',[session.shift.id]);
      if(s.organisation_id!==session.org.id||s.workspace_id!==session.im.workspaceId||v.id!==s.venue_id||assignments.length!==1||assignments[0].staff_profile_id!==session.staff.profileId||!['confirmed','completed'].includes(assignments[0].status))throw Error('Isolation or assignment proof failed');
      return {shift:s,venue:v,assignments,attendance};
    });
    const staffToken=await login(session.staff);
    const history=await api(staffToken,'/attendance/me/history');
    const active=await api(staffToken,'/attendance/me/active');
    const publicProof={capturedAt:new Date().toISOString(),organisationId:session.org.id,workspaceId:session.im.workspaceId,staffUserId:session.staff.userId,venueManagerUserId:session.vm.userId,upcomingShiftId:session.upcoming?.id,qrSha256:session.qrSha256,activeAttendanceId:active.attendance?.id??null,history:(history.data??history).filter(r=>r.shiftId===session.shift.id).map(r=>({id:r.id,status:r.status,workedMinutes:r.workedMinutes,clockOutAt:r.clockOutAt})),...proof};
    fs.writeFileSync(path.join(__dirname,process.argv[2]==='setup'?'fixture-proof.json':'attendance-proof-'+process.argv[2]+'.json'),JSON.stringify(publicProof,null,2));
    console.log(JSON.stringify(publicProof,null,2));
  } finally {await db.destroy();await owner.destroy();}
}
main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

