// Opens the real app in a disposable, visibly labelled synthetic browser context.
const {chromium}=require('playwright');
const {installUpNext}=require('./up-next-fixtures.cjs');
const {APP_ORIGIN}=require('./fixtures.cjs');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:false});const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-GB',timezoneId:'Europe/London'});const page=await context.newPage();await installUpNext(page,{scenario:process.argv[2]||'populated',ai:!process.argv.includes('--no-ai')});await page.goto(APP_ORIGIN+'/up-next');console.log('Synthetic demo only. Close this browser and rerun to reset. No real accounts, emails, data writes or AI requests.');await new Promise(resolve=>browser.on('disconnected',resolve));})().catch(e=>{console.error(e);process.exitCode=1;});
