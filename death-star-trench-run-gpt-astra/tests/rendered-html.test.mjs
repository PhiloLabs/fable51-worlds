import assert from 'node:assert/strict';
import test from 'node:test';

// Render the actual deployment Worker: catches browser-only imports leaking into SSR.
test('production Worker serves the mission and sharing metadata', async()=>{
 const {default:worker}=await import('../dist/server/index.js');
 const response=await worker.fetch(new Request('https://mission.example/',{headers:{accept:'text/html',host:'mission.example'}}),{ASSETS:{fetch:async()=>new Response('Not found',{status:404})}},{waitUntil(){},passThroughOnException(){}});
 assert.equal(response.status,200);
 assert.match(response.headers.get('content-type')??'',/^text\/html/);
 const html=await response.text();
 assert.match(html,/THE BATTLE/);assert.match(html,/WATCH CINEMATIC/);assert.match(html,/MISSION BRIEF/);
 assert.match(html,/Rogue Squadron/);assert.match(html,/property="og:image"/);assert.match(html,/https:\/\/mission\.example\/og\.png/);
 assert.doesNotMatch(html,/codex-preview|react-loading-skeleton|Your site is taking shape/);
});
