import test from 'node:test';
import assert from 'node:assert/strict';
import {cloneScreenshotRecord, inferReviewEventKind, reviewStateProjection} from '../dist/review-recorder.mjs';
import {estimateOrderRisk} from '../dist/engine.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const appSource=readFileSync(new URL('../dist/app.mjs',import.meta.url),'utf8');
const screenshotStart=appSource.indexOf('function reviewActionLabel(');
const screenshotHelpers=appSource.slice(screenshotStart,appSource.indexOf('\nfunction recordReviewEvent(',screenshotStart));
const helperContext={pretty:value=>Number.isFinite(value)?Number(value).toFixed(2):'—',protectionText:value=>Number.isFinite(value)?Number(value).toFixed(2):'未设置'};
vm.runInNewContext(`${screenshotHelpers}\nglobalThis.screenshotHelpers={reviewActionLabel,reviewExitRows,drawReviewExitCard,resolveReviewScreenshotOrder,resolveReviewScreenshotTrade,screenshotPriceCaption,screenshotOrderEntryPrice};`,helperContext);
const riskStart=appSource.indexOf('function estimatePlanRiskSnapshot('),riskEnd=appSource.indexOf('\nfunction syncPlanSummary(',riskStart);
const riskContext={estimateOrderRisk,active:null};
vm.runInNewContext(`${appSource.slice(riskStart,riskEnd)}\nglobalThis.riskHelpers={estimatePlanRiskSnapshot,riskPreviewRows};`,riskContext);

test('review projection preserves only the current disclosed replay state and its view/model evidence', () => {
  const session = {symbol: 'BTCUSDT', cursor: 42, minuteCursorTime: 1234567800, currentPrice: 101,
    forming15m: [1234567800, 100, 102, 99, 101, 3], tf: 3600, ma: true, ma10: false,
    blind: true, volume: true, drawings: [{id: 'line-1'}], simulationModel: {id: 'isolated-v1'},
    futureRows: [[1234568400, 500, 999, 1, 700, 1000]]};
  const projected = reviewStateProjection(session);
  assert.deepEqual(projected.forming15m, session.forming15m);
  assert.equal(projected.minuteCursorTime, 1234567800);
  assert.equal(projected.volume, true);
  assert.deepEqual(projected.simulationModel, {id: 'isolated-v1'});
  assert.equal(Object.hasOwn(projected, 'futureRows'), false);
});

test('review projection is a detached before-snapshot for in-place trade mutations', () => {
  const session={symbol:'BTCUSDT',cursor:18,position:{orderId:'o-1',side:1,entry:100,stop:null,take:null},
    pending:null,orderHistory:[{id:'o-1',status:'filled',stop:null,take:null}],
    trades:[],drawings:[{id:'d-1',anchor:{time:900,price:101}}]};
  const before=reviewStateProjection(session);
  // Mirror confirmModification: capture projection, then the engine mutates
  // the live position and associated order-history records in place.
  session.position.stop=98;
  session.orderHistory[0].stop=98;
  const after=reviewStateProjection(session);
  assert.equal(before.position.stop,null);
  assert.equal(before.orderHistory[0].stop,null);
  assert.equal(inferReviewEventKind(before,after),'protection-changed');
  session.drawings[0].anchor.price=102;
  reviewStateProjection(session);
  assert.equal(before.drawings[0].anchor.price,101);
});

test('imported screenshot cloning preserves Blob bytes instead of JSON-cloning them away', async () => {
  const original=new Blob(['chart-pixels'],{type:'image/png'});
  const cloned=cloneScreenshotRecord({id:'shot-1',sessionId:'s-1',blob:original,eventId:'s-1:1'});
  assert.ok(cloned.blob instanceof Blob);
  assert.equal(cloned.blob.type,'image/png');
  assert.equal(await cloned.blob.text(),'chart-pixels');
});

test('semantic inference distinguishes submitted orders, fills, protection changes, drawings, and note edits', () => {
  const base = {pending: null, position: null, orderHistory: [], trades: [], drawings: [], notes: '',
    tf: 900, ma: false, ma10: false, blind: true, volume: true, speed: 1500, draftPlan: null,
    sizePercent: 10, leverage: 1, orderType: 'market'};
  assert.equal(inferReviewEventKind(base, {...base, pending: {id: 'o-1'}}), 'order-submitted');
  assert.equal(inferReviewEventKind(base, {...base, orderHistory: [{id: 'o-1', status: 'filled'}]}), 'order-filled');
  assert.equal(inferReviewEventKind({...base, position: {stop: null}}, {...base, position: {stop: 99}}), 'protection-changed');
  assert.equal(inferReviewEventKind(base, {...base, drawings: [{id: 'd-1'}]}), 'drawing-created');
  assert.equal(inferReviewEventKind(base, {...base, notes: '我当时的依据'}), 'note-change');
  assert.equal(inferReviewEventKind(base, {...base, tf: 3600}), 'view-setting');
  assert.equal(inferReviewEventKind(base, {...base, speed: 750}), 'playback-speed');
});

test('submission screenshot title follows the actual market or limit order type', () => {
  const {reviewActionLabel}=helperContext.screenshotHelpers;
  assert.equal(reviewActionLabel('order-submitted','market'),'市价单提交');
  assert.equal(reviewActionLabel('order-submitted','limit'),'限价挂单已提交');
  assert.equal(reviewActionLabel('order-filled','market'),'市价单成交');
  assert.equal(reviewActionLabel('order-filled','limit'),'限价单成交');
});

test('exit screenshot price labels use a fixed readable card while chart price lines keep raw coordinates', () => {
  const {reviewExitRows,drawReviewExitCard}=helperContext.screenshotHelpers;
  const trade={entry:1970.57,stop:1970.18,take:null,exit:1970.22,reason:'止损',pnl:-2.69};
  const rows=reviewExitRows(trade);
  assert.deepEqual(Array.from(rows,row=>row.label),['入场','止损','止盈','平仓']);
  assert.deepEqual(Array.from(rows,row=>row.price),['1970.57','1970.18','未设置','1970.22']);
  assert.equal(rows[1].rawPrice,1970.18,'line rendering retains the numerical level');
  const labels=[];
  const ctx={save(){},restore(){},measureText:text=>({width:String(text).length*7}),fillRect(){},strokeRect(){},fillText(text,x,y){labels.push({text,x,y});},set font(_value){},set fillStyle(_value){},set strokeStyle(_value){},set lineWidth(_value){},set textBaseline(_value){}};
  drawReviewExitCard(ctx,trade,12,12);
  const rowYs=labels.slice(0,4).map(item=>item.y);
  assert.deepEqual(rowYs,[23,39,55,71]);
  assert.ok(rowYs.every((value,index)=>index===0||value-rowYs[index-1]>=16));
  assert.match(labels.at(-1).text,/止损 · -2.69 U/);
});

test('plan screenshots are bound to their explicit plan and never inherit the prior closed trade', () => {
  const {resolveReviewScreenshotOrder,resolveReviewScreenshotTrade,screenshotPriceCaption}=helperContext.screenshotHelpers;
  const previous={id:'trade-old',orderId:'order-old',side:1,entry:100,stop:95,take:110,exit:98,pnl:-2,reason:'止损'};
  const plan={planId:'plan-next',side:-1,orderType:'limit',entryPrice:97,stop:100,take:null,notional:250};
  const annotation={reviewOrder:plan,phase:'pre-submit-plan'};
  assert.equal(resolveReviewScreenshotOrder(annotation,'order-plan-locked',{planId:'plan-next',reviewOrder:plan},null),plan);
  assert.equal(resolveReviewScreenshotTrade('order-plan-locked',annotation,{planId:'plan-next'},[previous]),null);
  assert.equal(screenshotPriceCaption('order-plan-locked',plan,null,{quotedPrice:97}),'计划报价 97.00');
  assert.equal(resolveReviewScreenshotOrder(annotation,'order-plan-locked',{planId:'other-plan',reviewOrder:plan},null),null,
    'a mismatched plan ID must not draw the supplied order context');
  assert.equal(helperContext.screenshotHelpers.screenshotOrderEntryPrice({entryPrice:97,fillPrice:96.98}),96.98,
    'filled order lines must use actual fill rather than quote');
  assert.equal(helperContext.screenshotHelpers.screenshotOrderEntryPrice(plan),97,
    'unfilled plan lines retain the quoted price');
  assert.equal(screenshotPriceCaption('order-filled',{entryPrice:97,fillPrice:96.98},null,{}),'成交价 96.98');
  assert.equal(screenshotPriceCaption('order-submitted',{type:'limit',status:'pending',entryPrice:97},null,{}),'限价 97.00');
  assert.equal(screenshotPriceCaption('order-submitted',{type:'market',status:'filled',entryPrice:100,fillPrice:100.02},null,{}),'成交价 100.02');
  assert.equal(screenshotPriceCaption('order-submitted',{type:'market',status:'filled',entryPrice:100,positionId:'position-123',entry:100.03},null,{}),'成交价 100.03',
    'string position IDs with a finite actual entry identify a fill');
  assert.equal(screenshotPriceCaption('order-submitted',{type:'market',status:'pending',entryPrice:100,entry:100},null,{}),'参考价 100.00',
    'an entry without fill or position evidence is not labeled as a fill');
});

test('exit screenshot lookup requires exact stable IDs and rejects missing or conflicting context', () => {
  const {resolveReviewScreenshotTrade}=helperContext.screenshotHelpers;
  const prior={id:'trade-a',orderId:'order-a',side:1,entry:100,exit:95,pnl:-5};
  const next={id:'trade-b',orderId:'order-b',side:-1,entry:90,exit:94,pnl:-4};
  assert.equal(resolveReviewScreenshotTrade('position-closed',null,{},[prior]),null,
    'a lone historical trade is not a valid fallback');
  assert.equal(resolveReviewScreenshotTrade('position-closed',{trade:next},{tradeId:'trade-b',orderId:'order-a'},[prior,next]),null,
    'all supplied IDs must identify the same trade');
  assert.equal(resolveReviewScreenshotTrade('position-closed',{trade:next},{tradeId:'trade-b',orderId:'order-b'},[prior,next]),next);
  assert.equal(resolveReviewScreenshotTrade('position-triggered',{trade:next},{tradeId:'trade-b',orderId:'order-b'},[prior,next]),null,
    'trigger stages are not final exit cards');
});

test('risk preview and locked plan snapshot use the same frozen net-cost estimate', () => {
  const {estimatePlanRiskSnapshot,riskPreviewRows}=riskContext.riskHelpers;
  const config={modelConfigId:'model-1',engineVersion:'engine-2',fee:{openRate:.0004,closeRate:.0004},slippage:{rate:.0002}};
  const plan={side:1,notional:1000,entryPrice:100,stop:95,take:110,orderType:'limit'};
  const estimate=estimatePlanRiskSnapshot(plan,102,config,estimateOrderRisk);
  assert.equal(estimate.basis,'limit-price-scenario');
  assert.equal(estimate.priceRisk,50);
  assert.ok(estimate.netStopRisk>estimate.priceRisk,'net stop estimate includes fees and slippage');
  assert.ok(estimate.expectedTakeProfitNet>0);
  assert.ok(estimate.netRewardRisk>0);
  const locked=structuredClone(estimate);
  plan.stop=97;
  assert.equal(locked.priceRisk,50,'the submitted plan keeps its original risk snapshot');
  assert.equal(estimatePlanRiskSnapshot(plan,102,config,estimateOrderRisk).priceRisk,30);
  assert.deepEqual(Array.from(riskPreviewRows(locked,25),row=>row[0]),
    ['价格差风险','预计止损净损失','用户亏损预算','预计止盈净收益','净盈亏比']);
  assert.equal(riskPreviewRows(null,null)[1][1],'暂不可计算');
});

test('imported history keeps a lean local index and the archive replay-time anchor', () => {
  const start=appSource.indexOf('function importedHistorySession('),end=appSource.indexOf('\nasync function importReviewFile(',start);
  assert.ok(start>=0&&end>start);
  const context={clone:value=>JSON.parse(JSON.stringify(value))};
  vm.runInNewContext(`${appSource.slice(start,end)}\nglobalThis.makeImported=importedHistorySession;`,context);
  const imported=context.makeImported({id:'archive-1',symbol:'ETHUSDT',start:25,startTime:999,trades:[{id:'t-1'}],
    ledger:[{kind:'balance'}],fills:[{id:'f-1'}],accountSnapshots:[{id:'a-1'}],riskChanges:[{id:'r-1'}],contextCandles:[[1,1,1,1,1,1]]},123456);
  assert.equal(imported.displayReplayFrom,123456);
  assert.deepEqual(JSON.parse(JSON.stringify(imported.trades)),[{id:'t-1'}]);
  for(const key of ['ledger','fills','accountSnapshots','riskChanges','contextCandles'])assert.equal(Object.hasOwn(imported,key),false);
});
