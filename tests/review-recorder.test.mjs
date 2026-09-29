import test from 'node:test';
import assert from 'node:assert/strict';
import {cloneScreenshotRecord, createReviewRecorder, inferReviewEventKind, normalizeSecondRow, normalizeSecondSource, reviewStateProjection} from '../dist/review-recorder.mjs';
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

function fakeIndexedDB() {
  const databases = new Map();
  class Store {
    constructor(database, name, keyPath) {
      this.database=database; this.name=name; this.keyPath=keyPath; this.indexNames={contains:()=>true};
    }
    createIndex() { return this; }
    index(name) { return {getAll: key => this._request(() => [...this.database.data.get(this.name).values()]
      .filter(value => value?.[name] === key?.value).map(value => structuredClone(value)))}; }
    _key(value) { return Array.isArray(this.keyPath) ? JSON.stringify(this.keyPath.map(key=>value[key])) : value[this.keyPath]; }
    _request(run, fail = false) {
      const request={result:undefined,error:null,onsuccess:null,onerror:null};
      this.database.currentTx._queue(request,()=>run(),this.name,fail);
      return request;
    }
    get(key) { return this._request(()=>{const value=this.database.data.get(this.name).get(JSON.stringify(key));return value===undefined?undefined:structuredClone(value);}); }
    getAll() { return this._request(()=>[...this.database.data.get(this.name).values()].map(value=>structuredClone(value))); }
    put(value) { return this._request(()=>{this.database.data.get(this.name).set(JSON.stringify(this._key(value)),structuredClone(value));return this._key(value);},true); }
  }
  class Tx {
    constructor(database, storeNames, mode) {
      this.database=database; this.storeNames=[].concat(storeNames); this.mode=mode; this.pending=0; this.aborted=false; this.completed=false;
      this.database.transactions.push(this); this.database.currentTx=this;
    }
    objectStore(name) {
      if(!this.storeNames.includes(name))throw new Error(`store not in transaction: ${name}`);
      return new Store(this.database,name,this.database.keyPaths.get(name));
    }
    _queue(request, action, storeName, isWrite) {
      this.pending++; clearTimeout(this.completeTimer);
      setTimeout(()=>{
        try {
          if(isWrite && this.database.failNextStore===storeName){this.database.failNextStore=null;throw new Error('injected IDB write failure');}
          request.result=action();
          this.database.operations.push({store:storeName,write:!!isWrite,transaction:this});
          request.onsuccess?.({target:request});
        } catch(error) {
          request.error=error; this.error=error; request.onerror?.({target:request}); this.onerror?.({target:this,error});
        }
        this.pending--; this._scheduleComplete();
      },0);
    }
    _scheduleComplete() {
      if(this.pending!==0||this.completed)return;
      clearTimeout(this.completeTimer);
      this.completeTimer=setTimeout(()=>{
        if(this.pending!==0||this.completed)return;
        this.completed=true;
        (this.aborted?this.onabort:this.oncomplete)?.({target:this});
      },0);
    }
    abort(){this.aborted=true;this._scheduleComplete();}
  }
  class DB {
    constructor() { this.data=new Map();this.keyPaths=new Map();this.transactions=[];this.operations=[];this.failNextStore=null;
      this.objectStoreNames={contains:name=>this.data.has(name)}; }
    createObjectStore(name,{keyPath}) { this.data.set(name,new Map());this.keyPaths.set(name,keyPath);return new Store(this,name,keyPath); }
    transaction(names,mode) { return new Tx(this,names,mode); }
  }
  return {databases,DB,open(name){
    const request={result:null,onsuccess:null,onerror:null,onupgradeneeded:null};
    setTimeout(()=>{
      let database=databases.get(name);
      if(!database){database=new DB();databases.set(name,database);request.result=database;request.transaction={objectStore:store=>new Store(database,store,database.keyPaths.get(store))};request.onupgradeneeded?.({target:request});}
      request.result=database;request.onsuccess?.({target:request});
    },0);
    return request;
  }};
}

function setupFakeStorage() {
  const old={indexedDB:globalThis.indexedDB,IDBKeyRange:globalThis.IDBKeyRange,localStorage:globalThis.localStorage};
  const fake=fakeIndexedDB();
  globalThis.indexedDB={open:(name,version)=>fake.open(name,version)};
  globalThis.IDBKeyRange={only:value=>({value})};
  const values=new Map();
  globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))};
  return {fake,restore(){for(const [key,value] of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}};
}

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

test('second rows batch into one IDB transaction and barriers preserve event, cutoff, and export order', async () => {
  const env=setupFakeStorage();
  try {
    const recorder=createReviewRecorder({secondBatchSize:32,secondBatchDelayMs:60_000});
    const day=1700000000, source={date:'2023-11-14',url:'https://example.test/day.zip',
      checksum_url:'https://example.test/day.zip.CHECKSUM',sha256:'a'.repeat(64)};
    const session={id:'batch-session',symbol:'BTCUSDT',cursor:2,start:0,trades:[],position:null,pending:null,
      secondCursorTime:day+1,replayGranularity:'seconds'};
    const writes=Array.from({length:5},(_,index)=>recorder.appendSecond(session.id,
      [day+index,100+index,101+index,99+index,100.5+index,index+1],source));
    const eventPromise=recorder.observe(session,{kind:'position-opened',view:{visibleThrough:day+2},
      before:{position:null},after:{position:{positionId:'p-1'}}});
    const event=await eventPromise;
    assert.equal(event.seq,1);
    await Promise.all(writes);
    const secondsTransactions=env.fake.databases.get('kline-replay-review-v1').transactions
      .filter(tx=>tx.mode==='readwrite'&&tx.storeNames.includes('seconds'));
    assert.equal(secondsTransactions.length,1,'five quick appendSecond calls should use one atomic batch write');
    const operations=env.fake.databases.get('kline-replay-review-v1').operations;
    const secondCommitOrder=Math.max(...operations.filter(item=>item.store==='seconds').map(item=>env.fake.databases.get('kline-replay-review-v1').transactions.indexOf(item.transaction)));
    const eventCommitOrder=Math.min(...operations.filter(item=>item.store==='events').map(item=>env.fake.databases.get('kline-replay-review-v1').transactions.indexOf(item.transaction)));
    assert.ok(secondCommitOrder<eventCommitOrder,'second rows must commit before the key event transaction');
    const watermarks=await recorder.captureWatermarks([session.id]);
    assert.equal(watermarks[session.id],1);
    const snapshot=await recorder.readSession(session.id,{maxSeq:watermarks[session.id],visibleThrough:day+2});
    assert.deepEqual(snapshot.secondRows.map(row=>row[0]),[day,day+1],
      'export/read cutoff is exclusive close time and hides the later queued rows');
    assert.equal(snapshot.events.length,1);
    assert.deepEqual(snapshot.secondDays,[source]);
  } finally { env.restore(); }
});

test('second batch failures reject append callers and remain visible through flush failure state', async () => {
  const env=setupFakeStorage();
  try {
    const recorder=createReviewRecorder({secondBatchSize:20,secondBatchDelayMs:60_000});
    const databaseName='kline-replay-review-v1';
    const write=recorder.appendSecond('failed-batch',[1700000000,10,12,9,11,4]);
    // Opening the DB before injecting the one-shot store failure makes the failure deterministic.
    await recorder.flush().catch(()=>{});
    const database=env.fake.databases.get(databaseName);
    database.failNextStore='seconds';
    const failedWrite=recorder.appendSecond('failed-batch',[1700000001,11,12,10,11,2]);
    const failedFlush=recorder.flush();
    await assert.rejects(failedWrite,/injected IDB write failure/);
    await assert.rejects(failedFlush,/injected IDB write failure/);
    // The initial row was flushed before failure injection; the failed second row was not silently accepted.
    await assert.doesNotReject(write);
  } finally { env.restore(); }
});

test('archive import drains seconds queued before its duplicate-ID check', async () => {
  const env=setupFakeStorage();
  try {
    const recorder=createReviewRecorder({secondBatchSize:20,secondBatchDelayMs:60_000});
    const rowPromise=recorder.appendSecond('import-barrier',[1700000000,10,12,9,11,4]);
    const result=await recorder.importSessionArchive({session:{id:'import-barrier',symbol:'BTCUSDT'},events:[],minutes:[]});
    await rowPromise;
    assert.equal(result.status,'conflict','the preceding batch must create the existing session before import checks its ID');
    const read=await recorder.readSession('import-barrier',{visibleThrough:1700000001});
    assert.deepEqual(read.secondRows,[[1700000000,10,12,9,11,4]]);
  } finally { env.restore(); }
});

test('review projection preserves second-resolution cutoff and currently forming disclosed minute', () => {
  const session={symbol:'BTCUSDT',cursor:42,minuteCursorTime:1234567800,secondCursorTime:1234567890,
    replayGranularity:'seconds',forming1m:[1234567860,10,12,9,11,4],
    forming1mMeta:{firstSecondTime:1234567860,lastSecondTime:1234567890,disclosedSeconds:31,contiguous:true}};
  const projected=reviewStateProjection(session);
  assert.equal(projected.replayGranularity,'seconds');
  assert.equal(projected.secondCursorTime,1234567890);
  assert.deepEqual(projected.forming1m,session.forming1m);
  assert.deepEqual(projected.forming1mMeta,session.forming1mMeta);
});

test('recorder accepts only valid real second OHLCV rows and checksum source descriptors', () => {
  const row=[1700000000,10,12,9,11,4];
  assert.deepEqual(normalizeSecondRow(row),row);
  assert.equal(normalizeSecondRow([1700000000,10,9,9,11,4]),null,'high cannot be below close');
  assert.equal(normalizeSecondRow([1700000000.5,10,12,9,11,4]),null,'second open time must be integer UTC seconds');
  const source={date:'2023-11-14',url:'https://example.test/day.zip',checksum_url:'https://example.test/day.zip.CHECKSUM',sha256:'a'.repeat(64)};
  assert.deepEqual(normalizeSecondSource(source),source);
  assert.equal(normalizeSecondSource({...source,sha256:'bad'}),null,'source hashes must be SHA-256');
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
