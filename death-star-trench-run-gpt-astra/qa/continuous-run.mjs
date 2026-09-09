import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[],network=[],samples=[],milestones=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.status()>=400)network.push({url:r.url(),status:r.status()})});
await page.goto(process.env.MISSION_URL||'http://localhost:3003/');await page.waitForFunction(()=>!document.querySelector('.primary')?.disabled,{timeout:30000});await page.screenshot({path:'qa/final-lobby.png'});
await page.getByRole('button',{name:'WATCH CINEMATIC',exact:true}).click();
const checkpoints=[['approach',8],['squadron',20],['interception',36],['surface-dive',54],['trench-entry',63],['trench-combat',89],['targeting',133],['torpedoes',141.5],['internal',144.4],['escape',154],['internal-failure',162],['core-ignition',165.7],['primary-explosion',169.5],['shockwave',173],['debris',182],['flypast',184.5],['victory',188.1]];
let next=0;const start=Date.now();let lastSample=0;
while(Date.now()-start<330000){
 const state=await page.locator('.world').evaluate(el=>({time:Number(el.dataset.time),fps:Number(el.dataset.fps),player:el.dataset.player}));
 if(Date.now()-lastSample>900){samples.push(state);lastSample=Date.now()}
 if(next<checkpoints.length&&state.time>=checkpoints[next][1]){const[name,time]=checkpoints[next];await page.screenshot({path:`qa/final-${name}.png`});const phase=await page.locator('.flight-heading h2').textContent();console.log(JSON.stringify({milestone:name,time:state.time,phase,fps:state.fps}));milestones.push({name,expected:time,...state,phase});next++}
 if(await page.getByRole('button',{name:'FLY AGAIN',exact:true}).isVisible())break;
 await page.waitForTimeout(200);
}
const completed=await page.getByRole('button',{name:'FLY AGAIN',exact:true}).isVisible();
if(completed&&!milestones.some(x=>x.name==='victory')){await page.screenshot({path:'qa/final-victory.png'});milestones.push({name:'victory',time:188,phase:'MISSION COMPLETE'})}
const fps=samples.filter(x=>x.time>3).map(x=>x.fps).sort((a,b)=>a-b);
const report={completed,elapsedSeconds:(Date.now()-start)/1000,mode:'uninterrupted autonomous cinematic; no seeks',viewport:'1440x900',fps:{median:fps[Math.floor(fps.length/2)],p10:fps[Math.floor(fps.length*.1)],minimum:fps[0]},milestones,errors,network,samples};await writeFile('qa/continuous-report.json',JSON.stringify(report,null,2));console.log('FINAL',JSON.stringify({...report,samples:undefined,milestones:milestones.map(x=>x.name)}));await browser.close();if(!completed||errors.length||network.length||milestones.length<17)process.exitCode=1;
