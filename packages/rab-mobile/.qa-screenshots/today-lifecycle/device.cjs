const fs = require('fs');
const {execFileSync} = require('child_process');
const adb = 'C:/Users/issac/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const run = (...a) => execFileSync(adb, ['-s','emulator-5554',...a], {encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function nodes() {
  run('shell','uiautomator','dump','/sdcard/colour.xml');
  const xml=run('shell','cat','/sdcard/colour.xml');
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2].replaceAll('&#10;','\n').replaceAll('&amp;','&')])));
}
function tap(n) {if(!n)throw Error('UI node missing');const b=n.bounds.match(/\d+/g).map(Number);run('shell','input','tap',String((b[0]+b[2])/2|0),String((b[1]+b[3])/2|0));}
async function capture(name) {await sleep(700);run('shell','screencap','-p','/sdcard/colour.png');run('pull','/sdcard/colour.png',__dirname+'/'+name+'.png');fs.writeFileSync(__dirname+'/'+name+'.json',JSON.stringify(nodes().filter(n=>n['content-desc']).map(n=>({label:n['content-desc'],bounds:n.bounds})),null,2));}
(async()=>{
 const [action,arg]=process.argv.slice(2);
 if(action==='login'){
  const q=JSON.parse(fs.readFileSync(__dirname+'/.qa-session.json'))[arg];
  const fields=nodes().filter(n=>n.class==='android.widget.EditText');
  tap(fields[0]);run('shell','input','text',q.email);tap(nodes().filter(n=>n.class==='android.widget.EditText')[1]);run('shell','input','text',q.password);run('shell','input','keyevent','4');tap(nodes().find(n=>n['content-desc']==='Log in'));await sleep(2000);
 } else if(action==='tap'){tap(nodes().find(n=>n['content-desc']===arg||n.text===arg||n['content-desc']?.startsWith(arg+'\n')));await sleep(700);}
 else if(action==='capture')await capture(arg);
 else if(action==='back'){run('shell','input','keyevent','4');await sleep(700);}
 else if(action==='swipe'){const a=arg.split(',');run('shell','input','swipe',...a);await sleep(700);}
 else if(action==='diagnose'){const all=nodes();console.log(all.filter(n=>n.class!=='android.widget.EditText').map(n=>n['content-desc']||n.text).filter(Boolean).filter(t=>!t.includes('@')&&t.length<150).join('\n'));console.log('Editable field lengths: '+all.filter(n=>n.class==='android.widget.EditText').map(n=>(n.text||'').length).join(','));}
 else if(action==='inspect')console.log(nodes().filter(n=>n['content-desc']).map(n=>n['content-desc']).join('\n'));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
