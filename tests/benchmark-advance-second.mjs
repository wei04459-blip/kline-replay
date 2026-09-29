import {performance} from 'node:perf_hooks';
import {advanceSecond, INITIAL} from '../dist/engine.mjs';

const HISTORY = Number(process.env.KLINE_BENCH_HISTORY ?? 100);
const SNAPSHOTS = Number(process.env.KLINE_BENCH_SNAPSHOTS ?? 3000);
const ITERATIONS = Number(process.env.KLINE_BENCH_ITERATIONS ?? 40);

function fixture() {
  const data=Array.from({length:4},(_,i)=>[i*900,100,101,99,100,10]);
  const session={version:1,id:'benchmark-session',symbol:'BTCUSDT',start:0,cursor:0,end:3,balance:INITIAL,
    position:null,pending:null,orderHistory:[],trades:[],tf:14400,blind:true,ma:false,notes:''};
  advanceSecond(session,[900,100,100.1,99.9,100,0.01],data);
  for(let i=0;i<HISTORY;i++){
    session.trades.push({id:`trade-${i}`,side:1,entry:100,exit:100,qty:1,notional:100,entryFee:0,fees:0,pnl:0,
      entryIndex:0,exitIndex:0,reason:'benchmark'});
    session.orderHistory.push({id:`order-${i}`,status:'filled',type:'limit',side:1,notional:100,entryPrice:100,
      fillIndex:0,fillPrice:100,placedIndex:0});
  }
  session.accountSnapshots=Array.from({length:SNAPSHOTS},(_,i)=>({seq:i+1,balance:INITIAL,equity:INITIAL,
    replayMarketTime:900,details:{tag:`historical-${i}`}}));
  return {data,session};
}

function measure(run){
  const times=[];let {data,session}=fixture();
  for(let i=0;i<ITERATIONS;i++){
    const row=[901+i,100,100.1,99.9,100,0.01],started=performance.now();
    session=run(session,row,data);
    times.push(performance.now()-started);
  }
  times.sort((a,b)=>a-b);
  return {p50Ms:+times[Math.floor(times.length*0.5)].toFixed(3),p95Ms:+times[Math.floor(times.length*0.95)].toFixed(3),
    meanMs:+(times.reduce((sum,value)=>sum+value,0)/times.length).toFixed(3)};
}

// The control reproduces the old per-second whole-session draft allocation.
const wholeSessionDraft=measure((session,row,data)=>{
  const draft=structuredClone(session);
  advanceSecond(draft,row,data);
  return draft;
});
const shallowTransaction=measure((session,row,data)=>{
  advanceSecond(session,row,data);
  return session;
});
console.log(JSON.stringify({historyPerType:HISTORY,accountSnapshots:SNAPSHOTS,iterations:ITERATIONS,
  wholeSessionDraft,shallowTransaction},null,2));
