const path=require('path');
const fs=require('fs');
const {launch,go}=require('./common.cjs');
const {installUpNext}=require('./up-next-fixtures.cjs');
(async()=>{
 const out=process.argv[2];if(!out)throw Error('Pass an output directory');fs.mkdirSync(out,{recursive:true});
 const browser=await launch();const results=[];
 try {for(const [name,scenario,ai,width] of [['populated','populated',true,1440],['empty','empty',true,1440],['urgent','populated',true,1100],['ai-unavailable','populated',false,1440],['mobile','populated',true,390],['restricted','restricted',false,1440],['fully-staffed','fully-staffed',true,1440],['error','error',false,1440],['tablet','populated',true,768],['small-mobile','populated',true,320]]){
 const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:1,locale:'en-GB',timezoneId:'Europe/London',reducedMotion:'reduce'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await installUpNext(page,{scenario,ai});await go(page,'/up-next');
 await page.getByRole('heading',{name:'Your next move.'}).waitFor();await page.screenshot({path:path.join(out,'up-next-'+name+'.png'),fullPage:true});
 await page.locator('.up-next-content').screenshot({path:path.join(out,'up-next-'+name+'-content.png')});
 if(ai){await page.getByLabel('Ask Crewflow').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'up-next-'+name+'-composer.png')});}
 const leaked=await page.getByText('Expired synthetic offer').count();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(leaked||overflow||errors.length)throw Error(JSON.stringify({name,leaked,overflow,errors}));
 if(name==='populated'){const row=page.getByRole('button',{name:/Willow House.*unfilled/}).first();await row.focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Close timeline',exact:true}).waitFor();await page.getByRole('button',{name:'Close timeline',exact:true}).click();await page.getByLabel('Ask Crewflow').fill('Which shifts need staff?');await page.getByRole('button',{name:'Continue in AI chat'}).click();await page.waitForURL('**/chat');const draft=await page.locator('textarea').allTextContents();if(!draft.some(t=>t.includes('Which shifts need staff?')))throw Error('AI draft was not carried into existing chat');}
 results.push({name,errors,overflow,expiredOfferHidden:!leaked});await context.close();
 }fs.writeFileSync(path.join(out,'up-next-browser-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
