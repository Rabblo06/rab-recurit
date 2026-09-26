const {execFileSync,spawnSync}=require('child_process');
const env={...process.env};const c=JSON.parse(execFileSync('docker',['inspect','rab-server-1'],{encoding:'utf8'}))[0];for(const item of c.Config.Env){const n=item.indexOf('=');env[item.slice(0,n)]=item.slice(n+1);}
for(const key of ['DATABASE_URL','DATABASE_URL_UNPOOLED']){const u=new URL(env[key]);if(u.hostname!=='postgres')throw Error('Local test database only');u.hostname='127.0.0.1';u.port='55432';env[key]=u.toString();}
env.REDIS_URL='redis://127.0.0.1:6379/9';env.EMAIL_DRIVER='LOGGER';
const result=spawnSync(process.execPath,['node_modules/jest/bin/jest.js','--config','packages/rab-server/jest.config.ts','--runInBand','--testTimeout=60000','--forceExit','--runTestsByPath','packages/rab-server/src/__tests__/integration/scheduling-offer-abuse-cases.integration.spec.ts','packages/rab-server/src/__tests__/integration/attendance-abuse-cases.integration.spec.ts'],{env,stdio:'inherit'});process.exitCode=result.status??1;
