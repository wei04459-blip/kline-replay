import test from 'node:test';
import assert from 'node:assert/strict';
import {inferReviewEventKind, reviewStateProjection} from '../dist/review-recorder.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const appSource=readFileSync(new URL('../dist/app.mjs',import.meta.url),'utf8');
const screenshotHelpers=appSource.slice(appSource.indexOf('function reviewActionLabel('),appSource.indexOf('\nfunction recordReviewEvent(',appSource.indexOf('function reviewActionLabel(')));
const helperContext={pretty:value=>Number.isFinite(value)?Number(value).toFixed(2):'—',protectionText:value=>Number.isFinite(value)?Number(value).toFixed(2):'未设置'};
vm.runInNewContext(`${screenshotHelpers}\nglobalThis.screenshotHelpers={reviewActionLabel,reviewExitRows,drawReviewExitCard};`,helperContext);

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
