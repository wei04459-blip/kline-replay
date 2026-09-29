import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../dist/app.mjs',import.meta.url),'utf8');
const start=source.indexOf('function renderChart('),end=source.indexOf('\nfunction queuePlaybackRender(',start);
assert.ok(start>=0&&end>start,'renderChart should remain identifiable');

test('chart updates the tail, closes the previous bucket, and resets on rolling windows or timeframe changes',()=>{
  const calls={candleSet:[],candleUpdate:[],volumeSet:[],volumeUpdate:[],maSet:[],maUpdate:[],ma10Set:[],ma10Update:[]};
  const series=(set,update)=>({setData(rows){calls[set].push(rows);},update(row){calls[update].push(row);},applyOptions(){}});
  const context={
    active:{id:'s1',symbol:'BTCUSDT',tf:120,volume:true,ma:true,ma10:true},candleSeries:series('candleSet','candleUpdate'),
    volumeSeries:series('volumeSet','volumeUpdate'),maSeries:series('maSet','maUpdate'),ma10Series:series('ma10Set','ma10Update'),
    chart:{applyOptions(){},timeScale(){return {fitContent(){},setVisibleLogicalRange(){}};}},
    chartDataContext:'',chartBarCount:0,chartLastBarTime:null,chartFirstBarTime:null,maDataKey:'',ma10DataKey:'',
    SMALL_TIMEFRAMES:new Set([60,120,180,300]),replayResolution:()=> '1s',
    disclosedBars:()=>context.bars,maSignature:()=>`${context.active.id}|${context.active.tf}|${context.bars[0]?.time}|${context.bars.length}`,
    computeMa:(bars,period=20)=>bars.slice(period-1).map((bar,index)=>({time:bar.time,value:index+1})),
    drawingTools:null,renderPlanOverlay(){},updateQuote(){},formatChartTime(){},activeDrawingTool:null
  };
  context.bars=Array.from({length:500},(_,index)=>({time:100+index*120,open:10,high:12,low:9,close:11,volume:5,complete:false}));
  const render=vm.runInNewContext(`${source.slice(start,end)}; renderChart;`,context);
  render();
  assert.equal(calls.candleSet.length,1);
  for(let tick=0;tick<100;tick++){context.bars[499]={...context.bars[499],high:14,close:13+tick/100,volume:9};render();}
  assert.equal(calls.candleSet.length,1,'100 same-bucket renders do not resend historical chart data');
  assert.equal(calls.candleUpdate.length,100);
  context.bars=[...context.bars,{time:context.bars.at(-1).time+120,open:13,high:15,low:12,close:14,volume:6,complete:false}];render();
  assert.deepEqual(calls.candleUpdate.slice(-2).map(row=>row.time),[context.bars[499].time,context.bars[500].time]);
  assert.deepEqual(calls.maUpdate.slice(-2).map(row=>row.time),[context.bars[499].time,context.bars[500].time]);
  context.bars=context.bars.slice(1);context.bars.push({...context.bars.at(-1),time:context.bars.at(-1).time+120});render();
  assert.equal(calls.candleSet.length,2,'a rolling first bar resets chart data');
  context.active.tf=300;render();
  assert.equal(calls.candleSet.length,3,'a timeframe change resets chart data');
});
