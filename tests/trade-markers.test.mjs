import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTradeMarkers, buildTradeMarkersThroughStage, tradeMarkerSignature} from '../dist/trade-markers.mjs';

const bars = [1000, 1060, 1120].map(time => ({time, open: 1, high: 2, low: .5, close: 1.5}));

test('trade markers use execution side rather than profit and map close-time boundaries to the observed candle', () => {
  const session = {id: 's1', fills: [
    {id: 'f1', seq: 1, positionId: 'long', side: 'entry', positionSide: 1, price: 100, time: 1060},
    {id: 'f2', seq: 2, positionId: 'long', side: 'exit', positionSide: 1, price: 90, time: 1120},
    {id: 'f3', seq: 3, positionId: 'short', side: 'entry', positionSide: -1, price: 90, time: 1120},
    {id: 'f4', seq: 4, positionId: 'short', side: 'exit', positionSide: -1, price: 100, time: 1180},
  ], trades: []};
  const markers = buildTradeMarkers(session, bars, 60);
  assert.deepEqual(markers.map(({time,position,shape,color,text})=>({time,position,shape,color,text})),[
    {time:1000,position:'belowBar',shape:'arrowUp',color:'#3b82f6',text:'开多'},
    {time:1060,position:'aboveBar',shape:'arrowDown',color:'#ef5350',text:'平多'},
    {time:1060,position:'aboveBar',shape:'arrowDown',color:'#ef5350',text:'开空'},
    {time:1120,position:'belowBar',shape:'arrowUp',color:'#3b82f6',text:'平空'},
  ]);
  assert.ok(markers.every(marker => marker.size === .65), 'trade arrows stay compact');
});

test('pending orders and legacy records without explicit execution times do not create markers', () => {
  const session = {id:'s2', pending:{id:'pending'}, fills:[], position:{positionId:'p1',side:1,entry:100,entryIndex:0},
    trades:[{id:'old',side:1,entry:100,exit:110,entryIndex:0,exitIndex:1}]};
  assert.deepEqual(buildTradeMarkers(session,bars,60),[]);
});

test('legacy explicit trade times remain usable and fill facts win without duplicate markers', () => {
  const trade={id:'t1',positionId:'p1',side:-1,entry:105,exit:95,entryTime:1060,exitTime:1180,entryFillId:'entry',exitFillId:'exit'};
  const session={id:'s3',fills:[
    {id:'entry',seq:1,positionId:'p1',side:'entry',positionSide:-1,price:105,time:1060},
    {id:'exit',seq:2,positionId:'p1',side:'exit',positionSide:-1,price:95,time:1180},
  ],trades:[trade]};
  assert.equal(buildTradeMarkers(session,bars,60).length,2);
  const legacy={id:'s4',fills:[],trades:[{...trade,entryFillId:undefined,exitFillId:undefined}]};
  assert.deepEqual(buildTradeMarkers(legacy,bars,60).map(marker=>marker.text),['开空','平空']);
  assert.notEqual(tradeMarkerSignature(session,bars,60),tradeMarkerSignature({...session,fills:session.fills.slice(0,1)},bars,60));
});

test('stage screenshots stop at that fill and do not reveal a same-candle exit', () => {
  const fills=[
    {id:'entry',seq:1,positionId:'p1',side:'entry',positionSide:1,price:100,time:1060},
    {id:'exit',seq:2,positionId:'p1',side:'exit',positionSide:1,price:99,time:1060},
  ];
  const session={id:'s5',fills,trades:[{id:'trade',positionId:'p1',side:1,entry:100,exit:99,
    entryTime:1060,exitTime:1060,entryFillId:'entry',exitFillId:'exit'}]};
  const entryStage={kind:'order-filled',fillId:'entry',marketTime:1060,after:{position:{entryFillId:'entry'}}};
  assert.deepEqual(buildTradeMarkersThroughStage(session,bars,60,entryStage).map(marker=>marker.text),['开多']);
  const exitStage={kind:'position-auto-closed',fillId:'exit',marketTime:1060};
  assert.deepEqual(buildTradeMarkersThroughStage(session,bars,60,exitStage).map(marker=>marker.text),['开多','平多']);
});

test('stage screenshots retain earlier timestamped legacy trades and triggered stages stop at entry', () => {
  const legacy={id:'legacy',side:-1,entry:105,exit:102,entryTime:1060,exitTime:1120};
  const fills=[
    {id:'entry',seq:1,positionId:'new',side:'entry',positionSide:1,price:100,time:1180},
    {id:'exit',seq:2,positionId:'new',side:'exit',positionSide:1,price:99,time:1180},
  ];
  const session={id:'s6',fills,trades:[legacy]};
  const triggered={kind:'position-triggered',marketTime:1180,after:{position:{entryFillId:'entry'}}};
  assert.deepEqual(buildTradeMarkersThroughStage(session,bars,60,triggered).map(marker=>marker.text),['开空','平空','开多']);
});
