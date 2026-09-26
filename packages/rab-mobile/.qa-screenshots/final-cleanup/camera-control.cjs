// Minimal gRPC framing for the emulator's documented float-vector camera API.
const http2=require('http2');
const method=process.argv[2]||'rotateVirtualSceneCamera';
if(!['rotateVirtualSceneCamera','setVirtualSceneCameraVelocity','getPhysicalModel','setPhysicalModel'].includes(method))throw Error('Camera methods only');
const values=process.argv.slice(3).map(Number);
let payload=Buffer.alloc(15);for(let i=0;i<3;i++){payload[i*5]=((i+1)<<3)|5;payload.writeFloatLE(values[i]||0,i*5+1);}
if(method==='getPhysicalModel')payload=Buffer.from([8,values[0]||0]);
if(method==='setPhysicalModel'){payload=Buffer.alloc(18);payload.set([8,values[0]||0,26,14,10,12]);for(let i=0;i<3;i++)payload.writeFloatLE(values[i+1]||0,6+i*4);}
const frame=Buffer.alloc(5);frame.writeUInt32BE(payload.length,1);
const client=http2.connect('http://127.0.0.1:8554');
const metadata=require('fs').readFileSync(process.env.LOCALAPPDATA+'/Temp/avd/running/pid_30880.ini','utf8');
const token=metadata.split(/\r?\n/).find(l=>l.startsWith('grpc.token=')).slice('grpc.token='.length);
const req=client.request({':method':'POST',':path':'/android.emulation.control.EmulatorController/'+method,'content-type':'application/grpc','te':'trailers','authorization':'Bearer '+token});
req.on('response',h=>console.log('Camera response:',h[':status'],h['grpc-status']??'',h['grpc-message']||''));
req.on('trailers',h=>console.log('Camera control status:',h['grpc-status'],h['grpc-message']||''));
req.on('data',b=>{if(method==='getPhysicalModel')console.log('Physical model bytes:',b.toString('hex'));});req.on('end',()=>client.close());req.on('error',e=>{console.error(e.message);client.close();process.exitCode=1;});req.end(Buffer.concat([frame,payload]));
