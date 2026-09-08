/**
 * GitHub Pages subpath check.
 *
 * Pages serves a project site from /<repo>/ rather than the domain root, which
 * is the single most common way a PWA deploy ends up as a white screen. This
 * serves `dist/` under exactly that shape and asserts the game boots, the
 * manifest's start_url and scope are right, the service worker registers,
 * activates and takes control, and an offline reload still works.
 *
 * Build first with a matching base path, e.g.:
 *   BASE_PATH=/my-repo/ npm run build && npm run check:pages
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
const ROOT='/Users/kjlkurt/code/games/rivet-rush-opus5';
const DIST=resolve(ROOT,'dist'); const PREFIX='/rivet-rush-opus5'; const PORT=4341;
const TYPES={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png',
  '.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.json':'application/json'};
const server=http.createServer(async (req,res)=>{
  let p=req.url.split('?')[0];
  if(!p.startsWith(PREFIX)){res.writeHead(404);return res.end('outside base');}
  p=p.slice(PREFIX.length)||'/';
  if(p==='/')p='/index.html';
  try{
    const buf=await readFile(join(DIST,p));
    res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream'});
    res.end(buf);
  }catch{res.writeHead(404);res.end('not found');}
});
await new Promise(r=>server.listen(PORT,r));
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const ctx=await b.newContext({viewport:{width:1000,height:640}});
const p=await ctx.newPage();
const errs=[]; const failed=[];
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
p.on('requestfailed',r=>{const f=r.failure(); if(f&&!f.errorText.includes('ERR_ABORTED')) failed.push(r.url()+' '+f.errorText);});
p.on('response',r=>{if(r.status()>=400) failed.push(`${r.status()} ${r.url()}`);});

await p.goto(`http://localhost:${PORT}${PREFIX}/`,{waitUntil:'load'});
await p.waitForFunction(()=>window.__rivet?.state()==='title',null,{timeout:40000});
console.log('✓ booted under subpath', PREFIX);
// Registration is async (dynamic import -> register -> activate); give it time.
await p.waitForFunction(async()=>{
  const rs=await navigator.serviceWorker.getRegistrations();
  return rs.length>0 && rs.some(r=>r.active);
},null,{timeout:20000}).catch(()=>{});
const sw=await p.evaluate(async()=>{
  const rs=await navigator.serviceWorker.getRegistrations();
  return {scopes:rs.map(r=>r.scope), active:rs.map(r=>!!r.active), controller:!!navigator.serviceWorker.controller};
});
console.log('  service worker:', JSON.stringify(sw));
const man=await p.evaluate(async()=>{
  const l=document.querySelector('link[rel=manifest]');
  if(!l) return 'no manifest link';
  const r=await fetch(l.href); const j=await r.json();
  return {href:l.href, start_url:j.start_url, scope:j.scope, icon:j.icons[0].src};
});
console.log('  manifest:', JSON.stringify(man));
// Wait for the worker to finish precaching and activate, then navigate once so
// it takes control of the page (a SW never controls the navigation that
// registered it).
await p.waitForFunction(async()=>{
  const rs=await navigator.serviceWorker.getRegistrations();
  return rs.some(r=>r.active);
},null,{timeout:60000}).catch(()=>{});
await p.reload({waitUntil:'load'});
await p.waitForFunction(()=>window.__rivet?.state()==='title',null,{timeout:40000});
const sw2=await p.evaluate(async()=>{
  const rs=await navigator.serviceWorker.getRegistrations();
  return {active:rs.map(r=>!!r.active), controller:!!navigator.serviceWorker.controller};
});
console.log('  after activation+reload:', JSON.stringify(sw2));
await p.evaluate(()=>{window.__rivet.play(false);window.__rivet.autoplay(true);});
await new Promise(r=>setTimeout(r,5000));
console.log('  gameplay state:', await p.evaluate(()=>window.__rivet.state()),
            'score:', await p.evaluate(()=>window.__rivet.game.runRef.score));
// offline reload
await new Promise(r=>setTimeout(r,2000));
await ctx.setOffline(true);
// Bypass the HTTP cache so only the service worker can satisfy the reload.
try{
  await p.reload({waitUntil:'load',timeout:20000});
  await p.waitForFunction(()=>window.__rivet,null,{timeout:25000});
  console.log('✓ offline reload under subpath OK');
}catch(e){console.log('✗ offline reload failed:',e.message); errs.push('offline: '+e.message);}
console.log(errs.length?`✗ errors: ${errs.slice(0,5).join(' | ')}`:'✓ no console/page errors');
console.log(failed.length?`✗ failed requests: ${[...new Set(failed)].slice(0,8).join(' | ')}`:'✓ no failed requests');
await b.close(); server.close();
