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
 const {AttendancePostShiftLifecycle1786672700000}=require(src+'/database/typeorm/core/migrations/1786672700000-AttendancePostShiftLifecycle');
 const owner=await new DataSource({...coreDataSourceOptions,url:process.env.DATABASE_URL_UNPOOLED,migrations:[AttendancePostShiftLifecycle1786672700000],logging:false,logger:undefined}).initialize();
 try {
  if(process.argv[2]==='migrate'){const applied=await owner.runMigrations();console.log(applied.map(m=>m.name));return;}
  if(process.argv[2]==='test'){
   process.env.REDIS_URL='redis://127.0.0.1:6379/9';process.env.EMAIL_DRIVER='LOGGER';
   const result=require('child_process').spawnSync(process.execPath,['node_modules/jest/bin/jest.js','--config','packages/rab-server/jest.config.ts','--runInBand','--forceExit','--testTimeout=60000','--runTestsByPath','packages/rab-server/src/__tests__/integration/worker-operations-abuse-cases.integration.spec.ts','--testNamePattern=post-shift lifecycle'],{env:process.env,stdio:'inherit'});
   process.exitCode=result.status??1;return;
  }
  if(!session.org.slug.startsWith('native-ui-qa-'))throw Error('QA tenant required');
  const db=await new DataSource({...coreDataSourceOptions,logging:false,logger:undefined}).initialize();
  try {
   const tenant=new TenantContextService(db);
   const {AuditService}=require(src+'/engine/core-modules/audit/audit.service');
   const {PostShiftLifecycleService}=require(src+'/modules/attendance/services/post-shift-lifecycle.service');
   const result=await tenant.runInTenantContext(context(),async m=>{
    const [row]=await m.query('SELECT id FROM core.attendance WHERE shift_id=$1 AND staff_profile_id=$2 AND organisation_id=$3 AND workspace_id=$4',[session.shift.id,session.staff.profileId,session.org.id,session.im.workspaceId]);
    if(!row)throw Error('Exact QA attendance missing');
    const transitions=await new PostShiftLifecycleService(new AuditService(tenant)).advance(m,row.id);
    const [state]=await m.query('SELECT id,status,clock_out_at,post_shift_completed_at,post_shift_expired_at FROM core.attendance WHERE id=$1',[row.id]);return {transitions,...state};
   });
   fs.writeFileSync(path.join(__dirname,'worker-proof-'+process.argv[2]+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{await db.destroy();}
 }finally{await owner.destroy();}
}
main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
