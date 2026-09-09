import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {writeFile, mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Source mission excerpts arranged to match the supplied 28.2-second reference.
// The existing Three.js assets, lighting, shaders and flight systems are reused.
const shots=[
  {start:0,end:2.4,from:0,to:7,name:'Station approach'},
  {start:2.4,end:4.8,from:16,to:21,name:'Squadron'},
  {start:4.8,end:6.6,from:24,to:28.8,name:'Starfighter tracking'},
  {start:6.6,end:9,from:32,to:37,name:'Interception'},
  {start:9,end:11.4,from:49,to:58,name:'Surface dive'},
  {start:11.4,end:13.8,from:69,to:73.5,name:'Trench entry'},
  {start:13.8,end:15.6,from:85,to:89,name:'Surface defenses'},
  {start:15.6,end:18.2,from:112,to:117,name:'Final trench run'},
  {start:18.2,end:19,from:132,to:137,name:'Target lock'},
  {start:19,end:20.4,from:137,to:144.8,name:'Torpedoes'},
  {start:20.4,end:21.15,from:145,to:157.9,name:'Escape'},
  {start:21.15,end:21.6,from:158,to:166,name:'Internal failure'},
  {start:21.6,end:25.8,from:166,to:178,name:'Explosion and shockwave'},
  {start:25.8,end:28.2,from:178,to:186,name:'Debris and flypast'},
];
const dir=path.resolve('output/reference-match');
await mkdir(dir,{recursive:true});
const entry=`
import {MissionEngine} from './app/experience/engine';
const shots=${JSON.stringify(shots)};
const container=document.getElementById('world');
const engine=new MissionEngine(container,()=>{});
cancelAnimationFrame(engine.frame);
engine.audio.enable=async()=>{};
engine.start(true);
const original=engine.animate;
let lastShot=-1;
let lastClipTime=0;
window.renderHighlight=(clipTime)=>{
  const shotIndex=shots.findIndex(s=>clipTime>=s.start&&clipTime<s.end);
  const index=shotIndex<0?shots.length-1:shotIndex;
  const shot=shots[index];
  const p=Math.max(0,Math.min(1,(clipTime-shot.start)/(shot.end-shot.start)));
  const source=shot.from+(shot.to-shot.from)*p;
  const dt=Math.max(1/120,Math.min(.06,clipTime-lastClipTime||1/60));
  if(index!==lastShot){engine.seek(source);lastShot=index;}
  engine.state.started=true;engine.state.complete=false;engine.state.paused=false;
  engine.state.time=source-dt;
  engine.displayTime=source-dt;
  const now=performance.now();engine.last=now-dt*1000;
  original(now);
  cancelAnimationFrame(engine.frame);
  lastClipTime=clipTime;
  window.telemetry={clipTime,source,shot:shot.name,fps:engine.state.fps};
};
window.renderHighlight(0);
window.ready=true;
`;
const built=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'iife',platform:'browser',target:'es2020',minify:true,write:false,define:{'process.env.NODE_ENV':'"production"'}});
const html='<!doctype html><html><head><meta charset="utf-8"><title>Comparison capture</title><style>html,body,#world{margin:0;width:100%;height:100%;overflow:hidden;background:#000}canvas{display:block}</style></head><body><div id="world"></div><script>'+built.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script></body></html>';
await writeFile(path.join(dir,'capture.html'),html);
await writeFile(path.join(dir,'edit-plan.json'),JSON.stringify({duration:28.2,left:'gpt6-astra',right:'fable5.1',shots},null,2));

const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1,offline:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
await page.goto(pathToFileURL(path.join(dir,'capture.html')).href);
await page.waitForFunction(()=>window.ready);
// Inspect the actual scene at every editorial beat before the recording.
for(const time of [1.2,3.6,5.7,7.8,10.2,12.6,14.7,16.9,18.6,19.7,20.8,21.4,22.2,23.7,25.4,27]){
  await page.evaluate(t=>window.renderHighlight(t),time);
  await page.screenshot({path:path.join(dir,`preview-${time.toFixed(1)}.png`)});
}
await page.evaluate(()=>{window.renderHighlight(0);});
const recording=await page.evaluate(async()=>{
  const canvas=document.querySelector('canvas');
  const stream=canvas.captureStream(30);
  const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm;codecs=vp8';
  const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:16000000});
  const chunks=[];const checkpoints=[];let lastSecond=-1;
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  const stopped=new Promise(resolve=>recorder.onstop=resolve);
  window.renderHighlight(0);
  const origin=performance.now();
  const finished=new Promise(resolve=>{
    const tick=now=>{
      const time=Math.min(28.2,(now-origin)/1000);
      window.renderHighlight(time);
      if(Math.floor(time)!==lastSecond){lastSecond=Math.floor(time);checkpoints.push({...window.telemetry});}
      if(time<28.2)requestAnimationFrame(tick);else resolve();
    };
    recorder.start(500);requestAnimationFrame(tick);
  });
  await finished;await new Promise(resolve=>setTimeout(resolve,120));
  recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
  const reader=new FileReader();const base64=await new Promise(resolve=>{reader.onload=()=>resolve(reader.result);reader.readAsDataURL(new Blob(chunks,{type:mime}));});
  return {base64:base64.split(',')[1],mime,width:canvas.width,height:canvas.height,checkpoints};
});
await writeFile(path.join(dir,'astra-capture.webm'),Buffer.from(recording.base64,'base64'));
const report={...recording,base64:undefined,errors};
await writeFile(path.join(dir,'capture-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
await browser.close();
if(errors.length)process.exitCode=1;
