import test from 'node:test';
import assert from 'node:assert/strict';
import {appendPlanVersion, createPlanVersion, executionStageSnapshots, findClosedTradeForPosition, modificationEvidence} from '../dist/review-plans.mjs';

test('plan versions preserve raw input and immutable chronology without overwriting earlier versions', () => {
  const session={id:'s-1',reviewPlans:[],modelConfigId:'model-v1'};
  const first=createPlanVersion({session,planId:'p-1',rawText:'  突破做多\n',timingClass:'pre-trade',
    submittedAt:'2026-09-26T01:00:00.000Z',visibleThrough:100,snapshotId:'snap-1',order:{entry:99,stop:97},
    account:{equity:1000},risk:{lossBudget:null,lossBudgetStatus:'not-provided'}});
  appendPlanVersion(session,first);
  const second=createPlanVersion({session,planId:'p-1',rawText:'补充：回踩失败退出',version:2,parentPlanId:'p-1',
    timingClass:'position',snapshotId:'snap-2'});
  appendPlanVersion(session,second);
  assert.equal(session.reviewPlans.length,2);
  assert.equal(session.reviewPlans[0].rawText,'  突破做多\n');
  assert.equal(session.reviewPlans[0].timingClass,'pre-trade');
  assert.equal(session.reviewPlans[1].version,2);
  assert.equal(session.reviewPlans[1].timingClass,'position');
  assert.throws(()=>appendPlanVersion(session,first),/不能覆盖/);
  first.order.entry=0;
  assert.equal(session.reviewPlans[0].order.entry,99,'stored plan is detached from the caller');
});

test('supplemental plan timing and optional modification reasons keep distinct nullable evidence', () => {
  const session={id:'s-2'};
  const post=createPlanVersion({session,planId:'p-closed',rawText:'出场后复盘补充',timingClass:'post-trade',author:'user',origin:'user'});
  assert.equal(post.structured,null);
  assert.equal(post.lossBudget,undefined);
  assert.equal(modificationEvidence({before:{stop:10},after:{stop:11},reason:'  '} ).reason,null);
  const edit=modificationEvidence({before:{stop:10},after:{stop:11},reason:'波动结构变化',replayMarketTime:120, riskChanges:[{before:10,after:11}]});
  assert.equal(edit.reason,'波动结构变化');
  assert.deepEqual(edit.riskChanges,[{before:10,after:11}]);
  assert.equal(edit.visibleThrough,120);
});

test('same-minute execution stage uses disclosed minute clock without inheriting later final trade state', () => {
  const before={cursor:5,minuteCursorTime:300,forming15m:[300,100,102,99,101,5],currentPrice:101,
    position:null,pending:{id:'o-1'},trades:[],account:{balance:1000}};
  const progressed={cursor:5,minuteCursorTime:360,forming15m:[360,101,103,100,102,7],currentPrice:102};
  const fill={seq:1,before:{position:null,pending:{id:'o-1'},balance:1000},after:{position:{orderId:'o-1',entry:101.8},pending:null,balance:999},
    replayState:{cursor:5,minuteCursorTime:360,forming15m:progressed.forming15m,currentPrice:102}};
  const exit={seq:2,before:{position:{orderId:'o-1',entry:101.8},pending:null,balance:999},after:{position:null,trade:{id:'t-1',orderId:'o-1'},pending:null,balance:998},
    replayState:fill.replayState};
  const fillSnapshot=executionStageSnapshots(before,progressed,fill);
  const exitSnapshot=executionStageSnapshots(before,progressed,exit);
  assert.equal(fillSnapshot.after.minuteCursorTime,360);
  assert.equal(fillSnapshot.after.currentPrice,102);
  assert.deepEqual(fillSnapshot.after.position,{orderId:'o-1',entry:101.8});
  assert.equal(fillSnapshot.after.trades.length,0,'the fill event cannot inherit the later same-minute exit');
  assert.equal(exitSnapshot.after.position,null);
  assert.equal(exitSnapshot.after.trade.id,'t-1');
  assert.equal(exitSnapshot.after.minuteCursorTime,360);
  assert.equal(before.minuteCursorTime,300,'capturing stages leaves the original before-snapshot unchanged');
});

test('supplement captured during a position can link only to its exact auto-closed trade', () => {
  const position={orderId:'order-7',side:1,entry:101,entryTime:900,planId:'plan-2'};
  const trades=[{id:'trade-other',orderId:'order-8',side:1,entry:101,entryTime:900},{id:'trade-7',orderId:'order-7',side:1,entry:101,entryTime:900}];
  assert.equal(findClosedTradeForPosition(trades,position).id,'trade-7');
  assert.equal(findClosedTradeForPosition(trades,{...position,orderId:'missing'}),null);
  const ambiguous=[{id:'a',side:1,entry:101,entryTime:900},{id:'b',side:1,entry:101,entryTime:900}];
  assert.equal(findClosedTradeForPosition(ambiguous,{side:1,entry:101,entryTime:900}),null,'ambiguous legacy matches are not guessed');
});

test('plan versions retain the explicit position-at-capture timing flag', () => {
  const session={id:'s-3',reviewPlans:[]};
  const plan=createPlanVersion({session,planId:'p-3',version:1,captureStartedInPosition:true});
  assert.equal(plan.captureStartedInPosition,true);
  const ordinary=createPlanVersion({session,planId:'p-4',version:1});
  assert.equal(ordinary.captureStartedInPosition,false);
});
