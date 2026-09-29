import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../dist/app.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/style.css',import.meta.url),'utf8');

test('timeframe buttons and UI labels expose every supported interval, with compact scroll on narrow screens',()=>{
  const htmlIntervals=[...html.matchAll(/data-tf="(\d+)"/g)].map(match=>Number(match[1]));
  const appIntervals=[...app.matchAll(/\[(\d+),'(?:1|2|3|5|15|30|45)分'/g)].map(match=>Number(match[1]));
  assert.deepEqual(htmlIntervals,[60,120,180,300,900,1800,2700,3600,14400,86400,604800]);
  assert.deepEqual(appIntervals.slice(0,7),[60,120,180,300,900,1800,2700]);
  assert.match(css,/\.timeframes\{[^}]*overflow-x:auto/);
  assert.match(css,/@media\(max-width:760px\)\{\.timeframes\{[^}]*justify-content:flex-start/);
  assert.match(app,/1分钟周期显示真实完整OHLC · 分钟内不模拟逐笔波动/);
});

function timeframeSwitcher({loadError=null}={}){
  const start=app.indexOf('async function switchTimeframe('),end=app.indexOf('\nfunction disclosedBars',start);
  assert.ok(start>=0&&end>start,'switchTimeframe should remain independently testable');
  const state={active:{id:'round-a',tf:900},transitionPending:false,smallTfRequest:0,
    smallTfStatus:{loading:false,error:'',missingDays:0},loads:0,renders:[],persists:[],toasts:[],notes:0};
  const sandbox={
    TF_LABELS:new Map([[60,'1分'],[120,'2分'],[180,'3分'],[300,'5分'],[900,'15分']]),
    SMALL_TIMEFRAMES:new Set([60,120,180,300]),
    ensureSmallTfHistory:async()=>{state.loads++;if(loadError)throw loadError;},
    syncMinuteNote:()=>{state.notes++;},render:(...args)=>state.renders.push(args),
    persist:options=>state.persists.push(options),toast:message=>state.toasts.push(message)
  };
  for(const key of Object.keys(state))Object.defineProperty(sandbox,key,{get:()=>state[key],set:value=>{state[key]=value;}});
  vm.runInNewContext(`${app.slice(start,end)}\nglobalThis.switcher=switchTimeframe;`,sandbox);
  return {switcher:sandbox.switcher,state};
}

test('small-timeframe switch waits for disclosed minute history and preserves playback/session clock',async()=>{
  const h=timeframeSwitcher();
  const session=h.state.active;
  session.time=1_700_000_000;session.isPlaying=true;
  await h.switcher(120);
  assert.equal(h.state.active,session);
  assert.equal(session.tf,120);
  assert.equal(session.time,1_700_000_000);
  assert.equal(session.isPlaying,true);
  assert.equal(h.state.loads,2,'recheck after loading in case playback advanced during the read');
  assert.deepEqual(h.state.renders,[[true]]);
  assert.equal(JSON.stringify(h.state.persists),JSON.stringify([{kind:'view-setting'}]));
});

test('failed small-timeframe history read leaves the previous interval active and offers retry by reselecting',async()=>{
  const h=timeframeSwitcher({loadError:new Error('offline')});
  await h.switcher(300);
  assert.equal(h.state.active.tf,900);
  assert.deepEqual(h.state.renders,[]);
  assert.deepEqual(h.state.persists,[]);
  assert.match(h.state.toasts[0],/offline/);
  assert.equal(h.state.smallTfStatus.error,'offline');
});
