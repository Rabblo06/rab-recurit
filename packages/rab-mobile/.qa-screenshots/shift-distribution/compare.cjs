const fs=require('fs');
const {chromium}=require('playwright');
(async()=>{
const rows=['home','detail'];
let html='<html><body style="margin:12px;font:14px sans-serif;background:#eee"><h1>Native colour distribution: five real shifts</h1>';
for(const row of rows){html+='<h2>'+row+'</h2><div style="display:flex;gap:8px">';for(let i=1;i<=5;i++)html+='<div>Shift '+i+'<br><img width="200" src="'+row+'-'+i+'.png"></div>';html+='</div>';}
html+='</body></html>';fs.writeFileSync(__dirname+'/comparison.html',html);
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1080,height:1200}});await page.goto('file:///'+__dirname.replaceAll('\\','/')+'/comparison.html');await page.screenshot({path:__dirname+'/comparison.png',fullPage:true});await browser.close();
})();
