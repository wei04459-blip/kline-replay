import {createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode, ColorType} from './vendor/charts.mjs';
import {INITIAL, FEE, SLIP, MAINTENANCE_MARGIN_RATE, BASE, WARMUP, createSession, validateSession, ensureEvidenceBaseline, aggregateReplay, intervalStart, replayPrice as engineReplayPrice, replayTime as engineReplayTime, replayEnded, advanceMinute, manualClosePosition, placeOrder, cancelOrder, updatePendingOrder, updateProtection, reconcileOrderProtections, maxNotional, positionLiquidationPrice, estimateOrderRisk, metrics} from './engine.mjs';
import {nextMinute} from './minute-data.mjs';
import {createDrawingTools, projectDrawing, resolveDrawingPalette} from './drawings.mjs';
import {createReviewRecorder, reviewStateProjection} from './review-recorder.mjs';
import {appendPlanVersion, createPlanVersion, executionStageSnapshots, findClosedTradeForPosition, modificationEvidence} from './review-plans.mjs';
import {buildReviewExport} from './review-export.mjs';
import {parseReviewImport} from './review-import.mjs';

const $ = id => document.getElementById(id);
const els = Object.fromEntries(['save-status','new-session','equity','pnl','unreal','trade-count','win-rate','symbol','coin-mark','ma','ma10','volume','blind','recenter','last-price','last-change','volume-value','ohlc','loading','play','step','step-minute','cancel-advance','retry-minute','speed','replay-status','progress-text','progress-bar','balance','notional','risk-preview','long','short','observation-open','order-hint','position-badge','position','journal-count','history-count','journal-content','notes','current-tab','history-tab','order-form','toast','new-dialog','confirm-new','info-dialog','export','review-export','review-import','review-import-file','review-export-status','review-export-download','rules','source-details','source-label','size-range','size-readout','leverage-range','leverage-readout','leverage-badge','notional-value','margin-value','entry-fee-value','liquidation-value','plan-actions','plan-hint','confirm-plan','cancel-plan','locate-plan','session-badge','order-reason-window','order-reason-drag','order-reason-summary','thesis-fields','thesis-choice','thesis-label-wrap','thesis-label','parent-trade','attempt-number','strategy-version','observation-fields','observation-status','observed-conditions','entry-reason','entry-reason-error','reason-cancel','reason-close','reason-confirm','loss-budget','loss-budget-status'].map(id=>[id,$(id)]));
const STORE_KEY = 'replay-lab-v1';
const TF_LABELS = new Map([[900,'15分'],[1800,'30分'],[2700,'45分'],[3600,'1小时'],[14400,'4小时'],[86400,'1日'],[604800,'1周']]);
const datasets = new Map();
let active = null;
let history = [];
let selectedHistoryId = null;
let journalMode = 'positions';
let pendingSymbol = null;
let isPlaying = false;
let playTimer = 0;
let minuteGeneration = 0;
let minuteRequestId = 0;
let minuteActionPending = false;
let fastForwarding = false;
let minuteRetryAction = null;
let toastTimer = 0;
let warnedStorage = false;
let transitionPending = false;
let invalidSavedActive = false;
let currentPayload = null;
let activePriceLines = [];
let maDataKey = null;
let ma10DataKey = null;
let uiPlan = null;
let modificationDraft = null;
let dragState = null;
let dragDraft = null;
let frozenPlanLevels = null;
let overlayFrame = 0;
let projectionFrame = 0;
let chartOverlay = null;
let selectedOrderType = 'market';
let pendingOrderRequest = null;
let reasonMode = 'entry';
let reasonWindowDrag = null;
let reasonFocusReturn = null;
let reasonSubmitting = false;
let reasonWindowPosition = null;
let reasonResumePlayback = false;
let drawingTools = null;
let activeDrawingTool = null;
let selectedDrawingId = null;
let drawingColorPopoverOpen = false;
let drawingAuditSnapshot = null;
let chart, candleSeries, maSeries, ma10Series, volumeSeries, resizeObserver;
const reviewRecorder=createReviewRecorder();
let reviewExporting=false,reviewImporting=false;
let reviewDownloadUrl=null;

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}
function setLoading(message, retry = false) {
  els.loading.replaceChildren();
  const label = document.createElement('div'); label.textContent = message; els.loading.append(label);
  if (retry) { const button=document.createElement('button');button.className='primary';button.textContent='重试读取行情';button.addEventListener('click',retryRecovery);els.loading.append(button); }
  els.loading.classList.remove('hidden');
}
function hideLoading(){els.loading.classList.add('hidden');}
function showSavedRecordRecovery(message){
  setLoading(`${message}。原记录仍保留，可先导出备份，或归档后开启新一轮。`,false);
  const exportButton=document.createElement('button');exportButton.className='primary';exportButton.textContent='导出保存记录';exportButton.addEventListener('click',downloadExport);
  const newButton=document.createElement('button');newButton.className='primary';newButton.textContent='归档并重新开始';newButton.addEventListener('click',()=>{hideLoading();startRound(active?.symbol||'BTCUSDT');});
  els.loading.append(exportButton,newButton);els['new-session'].disabled=true;
}
function safeParse(value) { try { return JSON.parse(value); } catch { return null; } }
function readSaved() {
  let raw;try{raw=localStorage.getItem(STORE_KEY);}catch(error){els['save-status'].textContent='无法读取本地记录';return null;}if(!raw) return null;
  const saved=safeParse(raw);
  if(!saved || saved.version!==1 || !Array.isArray(saved.history)) return null;
  history=saved.history.filter(x=>x&&x.session&&typeof x.id==='string');
  for(const item of history)if(item.imported)item.session.importedArchive=true;
  if(saved.active&&saved.active.version===1&&typeof saved.active.symbol==='string') active=saved.active;
  let repaired=false;
  if(active)repaired=reconcileOrderProtections(active)||repaired;
  for(const item of history)repaired=reconcileOrderProtections(item.session)||repaired;
  if(repaired)persist();
  return saved;
}
async function ensureLegacyEvidenceBaselines(){
  let changed=false;
  for(const item of history){
    const session=item?.session;if(!session||Array.isArray(session.modelConfigs)&&session.modelConfigs.length)continue;
    try{const data=await loadSymbol(session.symbol);if(validateSession(session,session.symbol,data))changed=ensureEvidenceBaseline(session,data)||changed;}catch{}
  }
  if(changed)persist({audit:false});
  return changed;
}
function persist(options={}) {
  try {
    localStorage.setItem(STORE_KEY,JSON.stringify({version:1,source:'Binance spot public archive; UI simulation',active,history}));
    els['save-status'].textContent='已保存在此浏览器'; warnedStorage=false;
    if(active&&options.audit!==false)void reviewRecorder.observe(active,{kind:options.kind,orderId:options.orderId,tradeId:options.tradeId,planId:options.planId,snapshotId:options.snapshotId,thesisId:options.thesisId,parentTradeId:options.parentTradeId,observationId:options.observationId,strategyVersion:options.strategyVersion,attemptNumber:options.attemptNumber,actor:options.actor||'user',modelConfigId:options.modelConfigId||active.modelConfigId||active.modelEvidence?.modelConfigId,timingClass:options.timingClass,reason:options.reason,modification:options.modification,references:options.capture?{...options.references,screenshotBindingVersion:'event-context-v2'}:options.references,before:options.before,after:options.after,view:options.view||reviewView(active),screenshot:options.capture?()=>captureReviewScreenshot(options.annotation||null,options.kind||'action',options):options.screenshot}).then(event=>{if(event?.screenshotMissing)setReviewStatus('关键操作截图缺失，复盘包会标明',true);}).catch(error=>setReviewStatus(`过程记录未完整保存：${error?.message||'本地存储不可用'}`,true));
    return true;
  }
  catch { els['save-status'].textContent='保存失败：浏览器存储空间不足'; if(!warnedStorage){toast('保存失败：浏览器存储空间不足，请导出备份后释放空间');warnedStorage=true;} return false; }
}
async function loadSymbol(symbol, retry=false) {
  if(datasets.has(symbol)&&!retry) return datasets.get(symbol);
  setLoading('正在读取 '+symbol+' 历史行情…');
  try {
    const response=await fetch(`./data/${encodeURIComponent(symbol)}.json`,{cache:retry?'reload':'default'});
    if(!response.ok) throw new Error(`行情文件读取失败（${response.status}）`);
    const payload=await response.json();
    if(payload.symbol!==symbol||payload.interval!==BASE||!Array.isArray(payload.candles)||payload.candles.length<3) throw new Error('行情文件格式不完整');
  datasets.set(symbol,payload.candles);
  currentPayload=payload;
    if(els['source-label'])els['source-label'].textContent=`Binance · ${payload.period} · ${(payload.gaps||[]).reduce((n,g)=>n+g.missingBars,0)} 根缺失未补造`;
    return payload.candles;
  } catch(error) { throw new Error(error?.message||'行情读取失败'); }
}
function clone(value){return JSON.parse(JSON.stringify(value));}
function reviewId(prefix='id'){return `${prefix}-${globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`}`;}
function reviewModelConfigId(session=active){return session?.modelConfigId||session?.modelEvidence?.modelConfigId||session?.simulationModel?.modelConfigId||session?.simulationModel?.id||null;}
function ensureReviewPlans(session=active){if(session&&!Array.isArray(session.reviewPlans))session.reviewPlans=[];return session?.reviewPlans||[];}
function reviewAccountSnapshot(session=active){const data=datasets.get(session?.symbol)||[],m=metrics(session,data);return {balance:session?.balance??null,equity:m.equity,availableBalance:m.availableBalance,usedMargin:m.usedMargin,reservedMargin:m.reservedMargin,unrealizedPnl:m.unreal};}
function candleTime(index){const data=datasets.get(active?.symbol);return data?.[index]?.[0]??0;}
function utcDate(epoch){return new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(epoch*1000));}
function relativeTime(epoch,session=active,symbol=session?.symbol){
  const source=datasets.get(symbol);
  const anchor=session?.displayReplayFrom??session?.startTime??(session?.importedArchive?NaN:(source?.[session?.start]?.[0]??NaN)+BASE);
  if(!Number.isFinite(anchor))return utcDate(epoch);
  const minutes=Math.round((epoch-anchor)/60);
  if(minutes<0){const m=-minutes;return `练习前 ${Math.floor(m/1440)?`${Math.floor(m/1440)}天 `:''}${Math.floor(m%1440/60)}时`;}
  if(minutes<60)return `T+${minutes}分`;
  if(minutes<1440)return `T+${Math.floor(minutes/60)}时${minutes%60?`${minutes%60}分`:''}`;
  return `T+${Math.floor(minutes/1440)}天${Math.floor(minutes%1440/60)?`${Math.floor(minutes%1440/60)}时`:''}`;
}
function showTime(epoch, blind=active?.blind,session=active){return blind?relativeTime(epoch,session,session?.symbol):utcDate(epoch);}
function pretty(n,d=2){return Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';}
function protectionText(value){return Number.isFinite(value)?pretty(value):'未设置';}
function currentData(){return datasets.get(active?.symbol)||[];}
function replayMark(session=active,data=currentData()){return engineReplayPrice(session,data);}
function replayClock(session=active,data=currentData()){return engineReplayTime(session,data);}
function replayIsEnded(session=active,data=currentData()){return replayEnded(session,data);}
function reviewView(session=active){
  const range=chart?.timeScale?.().getVisibleLogicalRange?.(),priceScale=chart?.priceScale?.('right'),apiPriceRange=priceScale?.getVisibleRange?.(),priceOptions=typeof priceScale?.options==='function'?priceScale.options():null;
  let priceRange=apiPriceRange?{from:apiPriceRange.from,to:apiPriceRange.to,source:'chart-api'}:null;
  const paneHeight=chart?.panes?.()?.[0]?.getHeight?.()??(chart?.timeScale?.().height?Math.max(0,$('chart').clientHeight-chart.timeScale().height()):null);
  if(!priceRange&&Number.isFinite(paneHeight)&&paneHeight>0&&candleSeries?.coordinateToPrice){const top=candleSeries.coordinateToPrice(0),bottom=candleSeries.coordinateToPrice(paneHeight);if(Number.isFinite(top)&&Number.isFinite(bottom))priceRange={from:Math.min(top,bottom),to:Math.max(top,bottom),source:'derived-from-screen-coordinates'};}
  const visibleThrough=replayClock(session,datasets.get(session?.symbol)||[]),currentBar=disclosedBars().at(-1);
  const bar=currentBar?{...clone(currentBar),openTime:currentBar.time,closeTimeExclusive:currentBar.time+(session?.tf??0),timeSemantics:'UTC-epoch-seconds',interval:session?.tf??null,complete:Number.isFinite(visibleThrough)&&Number.isFinite(session?.tf)?currentBar.time+session.tf<=visibleThrough:false}:null;
  return {symbol:session?.symbol??null,tf:session?.tf??null,ma:!!session?.ma,ma10:!!session?.ma10,blind:!!session?.blind,volume:session?.volume!==false,
    visibleThrough:Number.isFinite(visibleThrough)?visibleThrough:null,
    replayMarketTime:Number.isFinite(visibleThrough)?visibleThrough:null,
    replayMarketTimeSemantics:'latest-disclosed-minute-close-exclusive-utc-seconds',paneHeight:Number.isFinite(paneHeight)?paneHeight:null,
    logicalRange:range?{from:range.from,to:range.to}:null,priceRange:priceRange?{from:priceRange.from,to:priceRange.to}:null,
    priceRangeSource:priceRange?.source??'unavailable',
    priceScaleMode:priceOptions?.mode??null,indicators:[...(session?.ma10?[{name:'SMA',period:10,input:'close',implementation:'sma-v1'}]:[]),...(session?.ma?[{name:'SMA',period:20,input:'close',implementation:'sma-v1'}]:[])],
    drawings:clone(session?.drawings||[]),forming15m:session?.forming15m?clone(session.forming15m):null,
    minuteCursorTime:session?.minuteCursorTime??null,currentBar:bar,fastForwarding:!!fastForwarding};
}
function captureReviewScreenshot(annotation=null,kind='action',identifiers={}){
  if(!chart||!active)return Promise.resolve(null);
  try{
    const source=chart.takeScreenshot();
    if(!(source instanceof HTMLCanvasElement))return Promise.resolve(null);
    const host=$('chart'),canvas=document.createElement('canvas'),scaleY=source.height/Math.max(1,host.clientHeight),headerHeight=Math.round(34*scaleY);canvas.width=source.width;canvas.height=source.height+headerHeight;
    const ctx=canvas.getContext('2d');if(!ctx)return Promise.resolve(null);
    ctx.fillStyle='#13181b';ctx.fillRect(0,0,canvas.width,headerHeight);ctx.strokeStyle='#384246';ctx.beginPath();ctx.moveTo(0,headerHeight-.5);ctx.lineTo(canvas.width,headerHeight-.5);ctx.stroke();
    const actionLabels={'order-modified':'限价订单已修改','protection-changed':'保护价已修改','position-closed':'主动平仓','position-close-requested':'主动平仓请求','position-triggered':'保护阈值触发（分钟路径未知）','position-auto-closed':'自动平仓','order-plan-locked':'下单前计划锁定','plan-supplemented':'计划补充','drawing-created':'新增绘图','drawing-modified':'移动绘图','drawing-deleted':'删除绘图'};
    const tf=TF_LABELS.get(active.tf)||`${active.tf}s`,blindTime=showTime(replayClock(),active.blind,active),bar=disclosedBars().at(-1),coin=active.symbol.replace(/USDT$/,'');
    const screenshotOrder=resolveReviewScreenshotOrder(annotation,kind,identifiers,
      ['order-plan-locked','order-submitted','order-filled','position-closed','position-auto-closed','position-triggered','round-ended'].includes(kind)?null:effectivePlan());
    const closedTrade=resolveReviewScreenshotTrade(kind,annotation,identifiers,active.trades||[]);
    const id=identifiers.tradeId||identifiers.orderId||identifiers.planId||annotation?.tradeId||annotation?.orderId||annotation?.executionEvent?.tradeId||annotation?.executionEvent?.orderId||annotation?.trade?.id||annotation?.trade?.tradeId||annotation?.trade?.orderId||annotation?.orderFilled?.id||annotation?.reviewOrder?.id||annotation?.reviewOrder?.planId;
    const orderType=identifiers.orderType||screenshotOrder?.type||annotation?.order?.type||annotation?.orderFilled?.type||annotation?.position?.type||null;
    const side=identifiers.side??screenshotOrder?.side??closedTrade?.side;
    const quoteOrFill=screenshotPriceCaption(kind,screenshotOrder,closedTrade,identifiers);
    const lastTrade=active.trades?.at(-1),sameMinuteFinal=!!(annotation?.orderFilled||annotation?.executionEvent)&&!!lastTrade&&
      ((identifiers.tradeId&&String(lastTrade.id||lastTrade.tradeId)===String(identifiers.tradeId))||
       (identifiers.orderId&&String(lastTrade.orderId)===String(identifiers.orderId))||
       (annotation?.executionEvent?.tradeId&&String(lastTrade.id||lastTrade.tradeId)===String(annotation.executionEvent.tradeId)));
    const stageTag=annotation?.executionEvent?`引擎阶段${annotation.executionEvent.seq||''} · 同一分钟最终盘面，分钟内先后未知`:'';
    const tags=[`${coin}/USDT`,tf,reviewActionLabel(kind,orderType)||actionLabels[kind]||kind,side===1?'做多':side===-1?'做空':'',id?`#${String(id).slice(-8)}`:'',quoteOrFill,blindTime,sameMinuteFinal?'同一分钟最终图':'',stageTag,identifiers.fastForwarding??fastForwarding?'快进过程中生成':'',`${volumeSeries&&active.volume!==false?'VOL ':''}${active.volume!==false?`${pretty(bar?.volume,4)} ${coin}`:'成交量隐藏'}`].filter(Boolean).join('  ·  ');
    ctx.font=`${Math.round(12*scaleY)}px ui-monospace, SFMono-Regular, Menlo, monospace`;ctx.fillStyle='#d8e1e3';ctx.textBaseline='middle';ctx.fillText(tags,10*scaleY,headerHeight/2,canvas.width-20*scaleY);
    ctx.drawImage(source,0,headerHeight);
    const sx=source.width/Math.max(1,host.clientWidth),sy=scaleY;ctx.save();ctx.translate(0,headerHeight);ctx.scale(sx,sy);
    const plotWidth=chart.timeScale().width(),bars=disclosedBars();
    for(const drawing of active.drawings||[]){
      const projected=projectDrawing(drawing,bars,active.tf);if(!projected)continue;
      const palette=resolveDrawingPalette(drawing.type,drawing.colorPreset);
      ctx.beginPath();ctx.strokeStyle=drawing.type==='horizontal'?palette.line:'#e6ba69';ctx.lineWidth=1.2;ctx.setLineDash(drawing.type==='horizontal'?[]:[5,4]);
      if(drawing.type==='horizontal'){
        const y=candleSeries.priceToCoordinate(projected.anchor.price);if(Number.isFinite(y)){ctx.moveTo(0,y);ctx.lineTo(plotWidth,y);ctx.stroke();}
      }else if(drawing.type==='zone'){
        const x1=chart.timeScale().logicalToCoordinate(projected.start.logical),y1=candleSeries.priceToCoordinate(projected.start.price),x2=chart.timeScale().logicalToCoordinate(projected.end.logical),y2=candleSeries.priceToCoordinate(projected.end.price);
        if([x1,y1,x2,y2].every(Number.isFinite)){const x=Math.min(x1,x2),y=Math.min(y1,y2),width=Math.abs(x2-x1),height=Math.abs(y2-y1);ctx.fillStyle=palette.selectedFill;ctx.fillRect(x,y,width,height);ctx.strokeStyle=palette.border;ctx.setLineDash([]);ctx.strokeRect(x,y,width,height);}
      }else{
        const x1=chart.timeScale().logicalToCoordinate(projected.start.logical),y1=candleSeries.priceToCoordinate(projected.start.price),x2=chart.timeScale().logicalToCoordinate(projected.end.logical),y2=candleSeries.priceToCoordinate(projected.end.price);
        if([x1,y1,x2,y2].every(Number.isFinite)){ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}
      }
    }
    const order=screenshotOrder,executionStage=annotation?.executionEvent||null,stagePosition=executionStage?.position||executionStage?.after?.position||executionStage?.before?.position||null;
    if(stagePosition){
      const levels=[['入场',stagePosition.entry,'#e7be6d'],['止损',stagePosition.stop,'#f06d78'],['止盈',stagePosition.take,'#22c58b'],['强平',recordLiquidation(stagePosition),'#ff7272']];
      for(const [label,price,color] of levels){if(!Number.isFinite(price))continue;const y=candleSeries.priceToCoordinate(price);if(Number.isFinite(y)){ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([5,4]);ctx.moveTo(0,y);ctx.lineTo(plotWidth,y);ctx.stroke();ctx.setLineDash([]);ctx.font='11px ui-monospace, SFMono-Regular, Menlo, monospace';ctx.fillStyle=color;ctx.fillText(`${label} ${pretty(price)}`,Math.max(4,plotWidth-138),Math.max(12,y-4));}}
    }
    if(order){
      const levels=[['入场',order.entryPrice??order.entry,'#e7be6d'],['止损',order.stop,'#f06d78'],['止盈',order.take,'#22c58b'],['强平',recordLiquidation(order),'#ff7272']];
      for(const [label,rawPrice,color] of levels){const price=label==='入场'?screenshotOrderEntryPrice(order):rawPrice;if(!Number.isFinite(price))continue;const y=candleSeries.priceToCoordinate(price);if(!Number.isFinite(y))continue;ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([5,4]);ctx.moveTo(0,y);ctx.lineTo(plotWidth,y);ctx.stroke();ctx.setLineDash([]);ctx.font='11px ui-monospace, SFMono-Regular, Menlo, monospace';ctx.fillStyle=color;ctx.fillText(`${label} ${pretty(price)}`,Math.max(4,plotWidth-138),Math.max(12,y-4));}
    }
    if(closedTrade){
      for(const {label,rawPrice:price,color} of reviewExitRows(closedTrade)){if(!Number.isFinite(price))continue;const y=candleSeries.priceToCoordinate(price);if(Number.isFinite(y)){ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=label==='平仓'?1.5:1;ctx.setLineDash(label==='平仓'?[3,3]:[5,4]);ctx.moveTo(0,y);ctx.lineTo(plotWidth,y);ctx.stroke();ctx.setLineDash([]);}}
      drawReviewExitCard(ctx,closedTrade,12,12);
    }
    ctx.restore();
    return new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  }catch{return Promise.resolve(null);}
}
function setReviewStatus(message,warning=false){if(!els['review-export-status'])return;els['review-export-status'].textContent=message;els['review-export-status'].classList.toggle('warning',warning);}
function reviewActionLabel(kind,orderType){
  if(kind==='order-plan-locked')return '下单前计划锁定';
  if(kind==='order-submitted')return orderType==='market'?'市价单提交':orderType==='limit'?'限价挂单已提交':'订单已提交';
  if(kind==='order-filled')return orderType==='market'?'市价单成交':orderType==='limit'?'限价单成交':'订单已成交';
  return null;
}
function resolveReviewScreenshotOrder(annotation,kind,identifiers={},fallback=null){
  const stage=annotation?.executionEvent;
  const context=identifiers.reviewOrder||annotation?.reviewOrder||annotation?.order||annotation?.position||
    annotation?.orderFilled||stage?.position||stage?.after?.position||stage?.before?.position||fallback||null;
  if(!context)return null;
  const expectedOrder=identifiers.orderId||annotation?.orderId||stage?.orderId;
  const expectedPlan=identifiers.planId||annotation?.planId||stage?.planId;
  if(expectedOrder&&String(context.orderId||context.id||'')!==String(expectedOrder))return null;
  if(expectedPlan&&String(context.planId||'')!==String(expectedPlan))return null;
  return context;
}
function reviewEntityIds(entity){return {tradeId:entity?.tradeId||entity?.id||null,orderId:entity?.orderId||null,positionId:entity?.positionId||null};}
function screenshotOrderEntryPrice(order){return Number.isFinite(order?.fillPrice)?order.fillPrice:Number.isFinite(order?.entry)?order.entry:order?.entryPrice;}
function resolveReviewScreenshotTrade(kind,annotation,identifiers={},trades=[]){
  const exitKinds=new Set(['position-closed','position-auto-closed','round-ended']);
  if(!exitKinds.has(kind))return null;
  const stage=annotation?.executionEvent;
  const candidate=annotation?.trade||stage?.trade||stage?.after?.trade||annotation?.after?.trade||
    (Number.isFinite(annotation?.exit)?annotation:null);
  const candidateIds=reviewEntityIds(candidate);
  const wanted={tradeId:identifiers.tradeId||annotation?.tradeId||stage?.tradeId||candidateIds.tradeId||null,
    orderId:identifiers.orderId||annotation?.orderId||stage?.orderId||candidateIds.orderId||null};
  if(!wanted.tradeId&&!wanted.orderId)return null;
  const matches=(trade)=>{
    const ids=reviewEntityIds(trade);
    return (!wanted.tradeId||String(ids.tradeId||'')===String(wanted.tradeId))&&
      (!wanted.orderId||String(ids.orderId||'')===String(wanted.orderId));
  };
  if(candidate&&!matches(candidate))return null;
  const exact=(trades||[]).filter(matches);
  return exact.length===1?exact[0]:null;
}
function screenshotPriceCaption(kind,order,trade,identifiers={}){
  if(kind==='order-plan-locked')return Number.isFinite(order?.entryPrice)?`计划报价 ${Number(order.entryPrice).toFixed(2)}`:'';
  const hasPositionEvidence=typeof order?.positionId==='string'&&order.positionId.trim().length>0&&Number.isFinite(order?.entry);
  const actualFill=Number.isFinite(order?.fillPrice)?order.fillPrice:
    hasPositionEvidence?order.entry:
    kind==='order-filled'&&order?.status==='filled'&&Number.isFinite(order?.entry)?order.entry:null;
  if((kind==='order-filled'||kind==='order-submitted')&&Number.isFinite(actualFill))return `成交价 ${Number(actualFill).toFixed(2)}`;
  if(kind==='order-submitted'&&Number.isFinite(order?.entryPrice))return order?.type==='limit'?`限价 ${Number(order.entryPrice).toFixed(2)}`:`参考价 ${Number(order.entryPrice).toFixed(2)}`;
  if(trade&&Number.isFinite(trade.exit))return `平仓 ${Number(trade.exit).toFixed(2)}`;
  return Number.isFinite(identifiers.quotedPrice)?`计划报价 ${Number(identifiers.quotedPrice).toFixed(2)}`:'';
}
function reviewExitRows(trade){
  return [['入场',trade?.entry,'#e7be6d'],['止损',trade?.stop,'#f06d78'],['止盈',trade?.take,'#22c58b'],['平仓',trade?.exit,'#f5e6e7']]
    .map(([label,price,color])=>({label,rawPrice:price,price:protectionText(price),color}));
}
function drawReviewExitCard(ctx,trade,x,y){
  const rows=reviewExitRows(trade),rowHeight=16,summary=`${trade?.reason||'平仓'} · ${pretty(trade?.pnl)} U`;
  ctx.save();ctx.font='11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const width=Math.ceil(Math.max(...rows.map(row=>ctx.measureText(`${row.label} ${row.price}`).width),ctx.measureText(summary).width)+20),height=rows.length*rowHeight+24;
  ctx.fillStyle='rgba(17,20,22,.92)';ctx.fillRect(x,y,width,height);ctx.strokeStyle='#4b565b';ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,width-1,height-1);ctx.textBaseline='middle';
  rows.forEach((row,index)=>{ctx.fillStyle=row.color;ctx.fillText(`${row.label} ${row.price}`,x+9,y+11+index*rowHeight);});
  ctx.fillStyle='#e9eff0';ctx.fillText(summary,x+9,y+height-9);ctx.restore();
}
function recordReviewEvent(kind,{session=active,before,after,screenshot=false,view,orderId,tradeId,orderType,planId,snapshotId,thesisId,parentTradeId,observationId,strategyVersion,attemptNumber,actor='user',modelConfigId,timingClass,reason,modification,references,recordedAt,captureType}={}){
  if(!session)return;
  const annotation=after?.event||after?.trade||null;
  const screenshotSource=screenshot===true?()=>captureReviewScreenshot(annotation,kind,{orderId,tradeId,planId,orderType,fastForwarding:view?.fastForwarding}):screenshot||undefined;
  const screenshotReferences=screenshotSource?{...references,screenshotBindingVersion:'event-context-v2'}:references;
  return reviewRecorder.observe(session,{kind,before,after,view:view||reviewView(session),orderId,tradeId,planId,snapshotId,thesisId,parentTradeId,observationId,strategyVersion,attemptNumber,actor,modelConfigId:modelConfigId||session.modelConfigId||session.modelEvidence?.modelConfigId,timingClass,reason,modification,references:screenshotReferences,recordedAt,captureType,screenshot:screenshotSource})
    .catch(error=>setReviewStatus(`复盘过程记录未完整保存：${error?.message||'本地存储不可用'}`,true));
}
function reviewPlaybackSnapshot(session=active,playing=isPlaying,speed=Number(els.speed?.value)||1500){return {...reviewStateProjection(session||{}),playback:{playing,speed}};}
function recordPlaybackTransition(kind,beforePlaying,beforeSpeed=Number(els.speed.value)||1500){if(active)recordReviewEvent(kind,{before:reviewPlaybackSnapshot(active,beforePlaying,beforeSpeed),after:reviewPlaybackSnapshot(active,isPlaying,Number(els.speed.value)||1500)});}
function togglePlayWithAudit(){const before=isPlaying,speed=Number(els.speed.value)||1500;togglePlay();if(before!==isPlaying)recordPlaybackTransition(isPlaying?'playback-play':'playback-pause',before,speed);}
function pauseWithAudit(){const before=isPlaying,speed=Number(els.speed.value)||1500;pause();if(before&&!isPlaying)recordPlaybackTransition('playback-pause',before,speed);}
async function manualStep(kind){
  if(!active)return;const session=active,before=reviewStateProjection(session),wasPlaying=isPlaying,speed=Number(els.speed.value)||1500;
  pause();if(wasPlaying)recordPlaybackTransition('playback-pause',true,speed);minuteRetryAction=null;
  const result=kind==='step-minute'?await advanceOneMinute():await advanceToTfBoundary();
  if(active===session&&!result?.failed&&(before.cursor!==session.cursor||before.minuteCursorTime!==session.minuteCursorTime)){
    recordReviewEvent(kind,{session,before:{...before,playback:{playing:false,speed}},after:{...reviewStateProjection(session),playback:{playing:false,speed}},view:reviewView(session)});
  }
  return result;
}
function managedTarget(){
  if(!active)return null;
  if(active.pending)return {kind:'pending',id:String(active.pending.id),order:active.pending};
  if(active.position){const p=active.position,id=p.orderId?String(p.orderId):`${p.entryIndex??''}|${p.entryTime??''}|${p.side}|${p.entry}`;return {kind:'position',id,order:p};}
  return null;
}
function modificationIsCurrent(draft=modificationDraft){
  const current=managedTarget();return !!(draft&&current&&active?.id===draft._edit?.sessionId&&current.kind===draft._edit?.kind&&current.id===draft._edit?.id);
}
function ensureModificationDraft(){
  const target=managedTarget();if(!target)return null;
  if(modificationIsCurrent())return modificationDraft;
  const source=target.order,copy=clone(source);copy.stop=source.stop??null;copy.take=source.take??null;
  modificationDraft={...copy,changeReason:null,_edit:{sessionId:active.id,kind:target.kind,id:target.id,base:{entryPrice:source.entryPrice??source.entry,stop:source.stop??null,take:source.take??null}}};
  return modificationDraft;
}
function modificationChanged(draft=modificationDraft){
  if(!modificationIsCurrent(draft))return false;
  const base=draft._edit.base,entry=draft.entryPrice??draft.entry;
  return entry!==base.entryPrice||draft.stop!==base.stop||draft.take!==base.take;
}
function clearModificationDraft(){modificationDraft=null;dragDraft=null;dragState=null;frozenPlanLevels=null;}
function syncDraftsAfterMinute(){
  let changed=false;
  if(uiPlan?.orderType==='market'&&active){const price=replayMark();if(Number.isFinite(price)&&uiPlan.entryPrice!==price){uiPlan.entryPrice=price;if(dragDraft?.orderType==='market')dragDraft.entryPrice=price;active.draftPlan=clone(uiPlan);changed=true;}}
  if(modificationDraft&&!modificationIsCurrent()){clearModificationDraft();changed=true;}
  return changed;
}
function modifiedParts(base,next){
  const out=[];
  for(const [key,label] of [['stop','止损'],['take','止盈']])if(base[key]!==next[key])out.push(next[key]===null?`移除${label}`:base[key]===null?`新增${label} ${pretty(next[key])}`:`${label} ${pretty(base[key])}→${pretty(next[key])}`);
  if((base.entryPrice??base.entry)!==(next.entryPrice??next.entry))out.push(`入场价 ${pretty(base.entryPrice??base.entry)}→${pretty(next.entryPrice??next.entry)}`);
  return out;
}
function normalizeLeverage(value){return Number.isInteger(value)&&value>=1&&value<=100?value:1;}
function selectedLeverage(){if(active?.position)return normalizeLeverage(active.position.leverage);if(active?.pending)return normalizeLeverage(active.pending.leverage);return normalizeLeverage(uiPlan?.leverage??active?.leverage);}
function recordLeverage(record){return normalizeLeverage(record?.leverage);}
function recordMargin(record){if(Number.isFinite(record?.margin))return record.margin;const notional=Number.isFinite(record?.notional)?record.notional:Number.isFinite(record?.qty)&&Number.isFinite(record?.entry)?record.qty*record.entry:NaN;return Number.isFinite(notional)?notional/recordLeverage(record):NaN;}
function recordLiquidation(record){if(record?.marginMode!=='isolated-v1')return null;if(Number.isFinite(record.liquidationPrice))return record.liquidationPrice;return positionLiquidationPrice(record);}
function leverageMarginText(record){return `${recordLeverage(record)}× · 保证金 ${pretty(recordMargin(record))} U`;}
function liquidationText(record){const value=recordLiquidation(record);return Number.isFinite(value)?pretty(value):'未提供';}
function calcNotional(percent,leverage=selectedLeverage()){const balance=Math.max(0,active?.balance??INITIAL);return maxNotional(balance,percent,normalizeLeverage(leverage));}
function syncLeverage(persistNow=true){
  const leverage=selectedLeverage(),hasOrder=!!active?.position||!!active?.pending,locked=hasOrder||!!pendingOrderRequest;
  els['leverage-range'].value=String(leverage);els['leverage-readout'].textContent=`${leverage}×`;els['leverage-badge'].textContent=`${leverage}× 逐仓模拟`;els['leverage-range'].disabled=locked;
  document.querySelectorAll('[data-leverage]').forEach(button=>{const selected=Number(button.dataset.leverage)===leverage;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=locked;});
  const percent=Number.isFinite(active?.sizePercent)?active.sizePercent:10,amount=calcNotional(percent,leverage);
  if(active&&!hasOrder){active.leverage=leverage;if(uiPlan){uiPlan.leverage=leverage;uiPlan.notional=amount;active.draftPlan=clone(uiPlan);}}
  els.notional.value=String(hasOrder?(active.position?.notional??active.pending?.notional??amount):amount);
  renderLeverageEstimates();syncPlanSummary();if(persistNow&&active)persist();
}
function renderLeverageEstimates(){
  const managed=active?.position||active?.pending||null,plan=managed||uiPlan||null,leverage=plan?recordLeverage(plan):selectedLeverage();
  const notional=plan?.notional??calcNotional(active?.sizePercent??10,leverage),margin=plan?recordMargin(plan):notional/leverage,fee=Number.isFinite(notional)?notional*FEE:NaN;
  let liq=null;
  if(managed)liq=recordLiquidation(managed);
  else if(uiPlan){const entry=uiPlan.entryPrice??replayMark();if(Number.isFinite(entry)&&entry>0&&notional>0){const record={side:uiPlan.side,entry,qty:notional/entry,notional,margin:notional/leverage,leverage,marginMode:'isolated-v1'};liq=positionLiquidationPrice(record);}}
  els['notional-value'].textContent=`${pretty(notional)} U`;els['margin-value'].textContent=`${pretty(margin)} U`;els['entry-fee-value'].textContent=`${pretty(fee)} U`;els['liquidation-value'].textContent=Number.isFinite(liq)?pretty(liq):managed&&managed.marginMode!=='isolated-v1'?'旧记录未计算':'—';
  els['liquidation-value'].classList.toggle('liquidation-value',Number.isFinite(liq));
}
function setLeverage(value,persistNow=true,audit=true){
  if(pendingOrderRequest||active?.position||active?.pending||!active)return;
  const leverage=normalizeLeverage(Number(value));active.leverage=leverage;
  if(uiPlan){uiPlan.leverage=leverage;uiPlan.notional=calcNotional(active.sizePercent??10,leverage);active.draftPlan=clone(uiPlan);}
  syncLeverage(false);syncSize(active.sizePercent??10,false);renderLeverageEstimates();if(persistNow)persist({audit,kind:audit?'order-plan':undefined});
}
function syncSize(percent,persistNow=true){
  percent=Math.max(0,Math.min(100,Number(percent)||0));const amount=calcNotional(percent,selectedLeverage());
  if(active){active.sizePercent=percent;if(uiPlan){uiPlan.notional=amount;uiPlan.leverage=selectedLeverage();active.draftPlan=clone(uiPlan);}}
  const managed=active?.position||active?.pending,orderNotional=managed?.notional??amount,margin=managed?recordMargin(managed):orderNotional/selectedLeverage();
  els['size-range'].value=String(percent);els['size-readout'].textContent=`${percent.toFixed(1).replace(/\.0$/,'')}% · ${pretty(margin)} USDT 保证金`;els.notional.value=String(orderNotional);
  renderLeverageEstimates();syncPlanSummary();if(persistNow&&active)persist();
}
function beginPlan(side){
  if(pendingOrderRequest||!active||active.position||active.pending||transitionPending)return;
  const leverage=normalizeLeverage(active.leverage),entry=replayMark(),notional=calcNotional(active.sizePercent??10,leverage),previous=uiPlan;
  const stopDistance=previous&&Number.isFinite(previous.stop)?Math.abs(previous.entryPrice-previous.stop)/previous.entryPrice:null;
  const takeDistance=previous&&Number.isFinite(previous.take)?Math.abs(previous.take-previous.entryPrice)/previous.entryPrice:null;
  uiPlan={side,orderType:selectedOrderType,entryPrice:entry,stop:stopDistance===null?null:entry*(1-side*stopDistance),take:takeDistance===null?null:entry*(1+side*takeDistance),notional,leverage,reviewPlanId:previous?.reviewPlanId||reviewId('plan'),captureStartedAt:previous?.captureStartedAt||new Date().toISOString()};
  active.draftPlan=clone(uiPlan);els['plan-actions'].hidden=false;chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();renderPosition();syncPlanSummary();syncDirectionSelection();syncPlaybackControls();persist();
}
function syncDirectionSelection(){
  const hasOrder=!!active?.position||!!active?.pending;
  for(const [button,side,defaultLabel,selectedLabel] of [[els.long,1,'↗ 买入 / 做多','✓ 已选做多'],[els.short,-1,'↘ 卖出 / 做空','✓ 已选做空']]){
    const selected=!!uiPlan&&!hasOrder&&uiPlan.side===side;
    button.textContent=selected?selectedLabel:defaultLabel;
    button.setAttribute('aria-label',selected?`已选，${side===1?'买入 / 做多':'卖出 / 做空'}`:defaultLabel.replace(/^[↗↘]\s*/,''));
    button.setAttribute('aria-pressed',String(selected));
    button.classList.toggle('selected',selected);
  }
}
function validProtection(side,kind,price,anchor){
  if(!Number.isFinite(price)||price<=0||!Number.isFinite(anchor)||anchor<=0)return false;
  if(kind==='stop')return side===1?price<anchor:price>anchor;
  return side===1?price>anchor:price<anchor;
}
function protectionAnchor(plan){
  if(active?.position&&!uiPlan&&!active?.pending)return replayMark()??plan.entry;
  return plan.entryPrice??plan.entry;
}
function protectionPreviewValid(kind,price,plan){return validProtection(plan.side,kind,price,protectionAnchor(plan));}
function reasonBlocksReplay(mode=pendingOrderRequest?.mode){return mode==='entry'||mode==='exit';}
function chooseOrderType(type){
  if(pendingOrderRequest||active?.position||active?.pending)return;selectedOrderType=type;if(active)active.selectedOrderType=type;if(uiPlan){const old=uiPlan;uiPlan.orderType=type;if(type==='market'){const price=replayMark(),delta=price-old.entryPrice;uiPlan.entryPrice=price;if(Number.isFinite(uiPlan.stop))uiPlan.stop+=delta;if(Number.isFinite(uiPlan.take))uiPlan.take+=delta;}active.draftPlan=clone(uiPlan);chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();syncPlanSummary();persist();}
  $('market-type').classList.toggle('active',type==='market');$('limit-type').classList.toggle('active',type==='limit');if(active&&!uiPlan)persist();
}
function confirmPlan(){
  if(pendingOrderRequest||!uiPlan||!active||Number(els.notional.value)<=0){if(Number(els.notional.value)<=0)toast('请选择大于0%的仓位比例');return;}
  const wasPlaying=isPlaying,speed=Number(els.speed.value)||1500;reasonResumePlayback=wasPlaying;pause(false);if(wasPlaying)recordPlaybackTransition('playback-pause',true,speed);pendingOrderRequest={...clone(uiPlan),mode:'entry',sessionId:active.id,planId:uiPlan.reviewPlanId||reviewId('plan'),snapshotId:reviewId('snapshot'),captureStartedAt:uiPlan.captureStartedAt||new Date().toISOString(),account:reviewAccountSnapshot(active),view:reviewView(active)};reasonMode='entry';reasonSubmitting=false;reasonFocusReturn=els['confirm-plan'];els['reason-confirm'].disabled=false;
  els['entry-reason'].value=String(uiPlan.entryReason||'');els['entry-reason'].removeAttribute('aria-invalid');els['entry-reason-error'].textContent='';
  els['loss-budget'].value=Number.isFinite(uiPlan.lossBudget)?String(uiPlan.lossBudget):'';els['loss-budget-status'].textContent='';
  populateThesisFields({thesisId:uiPlan.thesisId||'',parentTradeId:uiPlan.parentTradeId||'',attemptNumber:uiPlan.attemptNumber||'',strategyVersion:uiPlan.strategyVersion||''});
  setReasonCopy('entry');els['reason-confirm'].disabled=!els['entry-reason'].value.trim();
  els['order-reason-summary'].textContent=reasonOrderSummary(pendingOrderRequest);
  els['reason-confirm'].textContent=`${pendingOrderRequest.orderType==='limit'?'提交限价':'确认市价'} · ${pendingOrderRequest.side===1?'买入 / 做多':'卖出 / 做空'}`;
  els['order-reason-window'].hidden=false;syncReasonControls();syncPlaybackControls();els.play.textContent='▶';els.play.setAttribute('aria-label','自动播放');positionReasonWindow();requestAnimationFrame(()=>els['entry-reason'].focus());
}
function positionIdentity(p){return p?.orderId?`order:${p.orderId}`:`${p?.entryIndex??''}|${p?.entryTime??''}|${p?.side??''}|${p?.entry??''}`;}
function requestExitReason({archiveSymbol=null,returnFocus=null}={}){
  if(pendingOrderRequest||!active?.position||transitionPending)return false;
  const position=active.position;
  const wasPlaying=isPlaying,speed=Number(els.speed.value)||1500;reasonResumePlayback=wasPlaying;pause(false);if(wasPlaying)recordPlaybackTransition('playback-pause',true,speed);
  const snapshotId=reviewId('snapshot'),before=reviewStateProjection(active),view=reviewView(active),startedAt=new Date().toISOString();
  pendingOrderRequest={mode:'exit',sessionId:active.id,positionId:positionIdentity(position),symbol:active.symbol,side:position.side,exitPrice:replayMark(),archiveSymbol,planId:position.planId||null,tradeId:position.tradeId||null,snapshotId,captureStartedAt:startedAt,before,view,account:reviewAccountSnapshot(active)};
  reasonMode='exit';reasonSubmitting=false;reasonFocusReturn=returnFocus||els['new-session'];
  els['entry-reason'].value='';els['entry-reason'].removeAttribute('aria-invalid');els['entry-reason-error'].textContent='';
  setReasonCopy('exit');els['reason-confirm'].textContent=archiveSymbol?'确认平仓并归档':'确认平仓';els['reason-confirm'].disabled=!els['entry-reason'].value.trim();
  const closeSummary=`${position.symbol?.replace?.('USDT','')||active.symbol.replace('USDT','')} · ${position.side===1?'买入 / 做多':'卖出 / 做空'} · 主动市价平仓\n预计平仓价 ${pretty(pendingOrderRequest.exitPrice)} · 杠杆 ${recordLeverage(position)}× · 保证金 ${pretty(recordMargin(position))} U`;
  els['order-reason-summary'].textContent=archiveSymbol?`${closeSummary}\n确认后将归档本轮并尝试开始新一轮。取消会保留本轮。`:closeSummary;
  recordReviewEvent('position-close-requested',{session:active,before,after:{...before,closeRequest:{positionId:pendingOrderRequest.positionId,price:pendingOrderRequest.exitPrice,account:pendingOrderRequest.account}},view,screenshot:true,planId:pendingOrderRequest.planId,tradeId:pendingOrderRequest.tradeId,snapshotId,actor:'user',timingClass:'in-position'});
  els['order-reason-window'].hidden=false;syncReasonControls();syncPlaybackControls();positionReasonWindow();requestAnimationFrame(()=>els['entry-reason'].focus());return true;
}
function requestPlanSupplement({trade=null,returnFocus=null}={}){
  if(pendingOrderRequest||!active)return false;
  const position=active.position,planId=trade?.planId||position?.planId||reviewId('plan'),tradeId=trade?.id||trade?.tradeId||position?.tradeId||null;
  const mode=trade?'supplement-after':'supplement-position',timingClass=trade?'post-trade':'position';
  reasonResumePlayback=false;
  pendingOrderRequest={mode,sessionId:active.id,planId,tradeId,positionId:position?positionIdentity(position):null,orderId:position?.orderId||null,positionSnapshot:position?clone(position):null,captureStartedInPosition:!trade&&!!position,timingClass,captureStartedAt:new Date().toISOString(),snapshotId:reviewId('snapshot'),before:reviewStateProjection(active),view:reviewView(active),account:reviewAccountSnapshot(active)};
  reasonMode='supplement';reasonSubmitting=false;reasonFocusReturn=returnFocus;els['entry-reason'].value='';els['entry-reason'].removeAttribute('aria-invalid');els['entry-reason-error'].textContent='';
  els['loss-budget'].value='';populateThesisFields();setReasonCopy('supplement');els['reason-confirm'].textContent='保存补充记录';els['reason-confirm'].disabled=true;
  els['order-reason-summary'].textContent=`${active.symbol.replace('USDT','')} · ${trade?'平仓后补充复盘（事后记录）':'持仓中追加计划'}\n原计划与原文不会被覆盖；本条将按${timingClass==='post-trade'?'事后':'持仓中'}版本另行保存。`;
  els['order-reason-window'].hidden=false;syncReasonControls();syncPlaybackControls();positionReasonWindow();requestAnimationFrame(()=>els['entry-reason'].focus());return true;
}
function syncDrawingControls(){
  const locked=reasonBlocksReplay()||!!transitionPending;
  for(const [id,tool] of [['drawing-select',null],['drawing-horizontal','horizontal'],['drawing-trendline','trendline'],['drawing-zone','zone']]){
    const button=$(id);if(!button)continue;const selected=activeDrawingTool===tool;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=locked;
  }
  const del=$('drawing-delete');if(del){del.disabled=locked||!selectedDrawingId;del.setAttribute('aria-disabled',String(del.disabled));}
  const selected=drawingTools?.getSelectedDrawing?.(),colorable=!!selected&&['horizontal','zone'].includes(selected.type);
  const colorButton=$('drawing-color'),popover=$('drawing-color-popover'),sample=$('drawing-color-sample');
  if(!colorable||locked)closeDrawingColorPopover();
  if(colorButton){colorButton.disabled=locked||!colorable;colorButton.setAttribute('aria-disabled',String(colorButton.disabled));colorButton.setAttribute('aria-expanded',String(drawingColorPopoverOpen));}
  if(popover){popover.hidden=!drawingColorPopoverOpen;for(const button of popover.querySelectorAll('[data-drawing-color-preset]')){
    const chosen=colorable&&button.dataset.drawingColorPreset===selected.colorPreset;button.setAttribute('aria-pressed',String(chosen));button.classList.toggle('selected',chosen);
  }}
  if(sample)sample.style.backgroundColor=colorable?resolveDrawingPalette(selected.type,selected.colorPreset).line:'#69aebd';
}
function closeDrawingColorPopover(){
  drawingColorPopoverOpen=false;const popover=$('drawing-color-popover'),button=$('drawing-color');
  if(popover)popover.hidden=true;if(button)button.setAttribute('aria-expanded','false');
}
function toggleDrawingColorPopover(){
  const selected=drawingTools?.getSelectedDrawing?.();
  if(!selected||!['horizontal','zone'].includes(selected.type)||pendingOrderRequest||transitionPending)return;
  drawingColorPopoverOpen=!drawingColorPopoverOpen;syncDrawingControls();
}
function chooseDrawingTool(tool){
  if(pendingOrderRequest||transitionPending)return;
  activeDrawingTool=tool;drawingTools?.setTool(tool);syncDrawingControls();
  chartOverlay?.classList.toggle('drawing-disabled',!!tool);
  $('drawing-hint').textContent=tool==='horizontal'?'点图放置水平线，或悬停价格轴旁＋':tool==='trendline'?'点击起点，然后点击终点':'悬停价格轴旁＋绘制水平线；趋势线点两次完成后可直接拖动';
}
function deleteSelectedDrawing(){
  if(pendingOrderRequest||transitionPending)return;
  if(!drawingTools?.deleteSelected()){toast('请先点击选中一条绘图');return;}
  syncDrawingControls();
}
function setReasonCopy(mode){
  const exiting=mode==='exit',supplement=mode==='supplement';$('order-reason-title').textContent=exiting?'填写平仓理由':supplement?'补充复盘记录':'填写下单理由';$('reason-prompt').textContent=exiting?'为什么现在主动平仓？':supplement?'补充当时的想法、持仓计划或事后复盘':'为什么在这里下单？';
  els['entry-reason'].placeholder=exiting?'写下主动退出的依据…':supplement?'原文会作为新版本保存，不会改写先前记录…':'写下你的判断依据…';els['reason-close'].setAttribute('aria-label',exiting?'取消本次平仓':supplement?'取消补充记录':'取消本次下单');
  $('loss-budget-details').hidden=mode!=='entry';els['thesis-fields'].hidden=mode==='exit';els['observation-fields'].hidden=mode!=='observation';
  if(mode==='observation'){$('order-reason-title').textContent='记录判断';$('reason-prompt').textContent='当时你在观察什么？';els['entry-reason'].placeholder='写下当时的判断或这次不做的原因…';els['reason-close'].setAttribute('aria-label','取消观察记录');}
}
function populateThesisFields({thesisId='',parentTradeId='',attemptNumber='',strategyVersion=''}={}){
  const thesis=els['thesis-choice'],parent=els['parent-trade'];thesis.replaceChildren(new Option('不关联想法',''),new Option('新建想法','__new__'));
  const known=new Map();for(const session of [active,...history.map(item=>item?.session)].filter(Boolean))for(const item of session.theses||[])if(item?.thesisId&&!known.has(item.thesisId))known.set(item.thesisId,item);
  for(const item of known.values())thesis.add(new Option(item.label||'未命名想法',item.thesisId));thesis.value=thesisId||'';els['thesis-label-wrap'].hidden=thesis.value!=='__new__';els['thesis-label'].value='';
  parent.replaceChildren(new Option('不关联前序交易',''));const trades=[];
  for(const session of [active,...history.map(item=>item?.session)].filter(Boolean))for(const trade of session.trades||[])trades.push({session,trade});
  for(const {session,trade} of trades){const id=String(trade.tradeId||trade.id||trade.orderId||'');if(!id)continue;const value=JSON.stringify({sessionId:session.id,tradeId:id}),label=`${session.symbol?.replace('USDT','')||''} ${trade.side===1?'多':'空'} · ${pretty(trade.pnl)} U · ${id.slice(-8)}`;parent.add(new Option(label,value));}
  parent.value='';if(parentTradeId){const match=trades.find(({trade})=>String(trade.tradeId||trade.id||trade.orderId||'')===String(parentTradeId));if(match)parent.value=JSON.stringify({sessionId:match.session.id,tradeId:parentTradeId});}
  els['attempt-number'].value=attemptNumber?String(attemptNumber):'';els['strategy-version'].value=strategyVersion||'';
}
function readThesisFields(session=active){
  const choice=els['thesis-choice'].value,label=els['thesis-label'].value.trim(),parentValue=els['parent-trade'].value;
  if(choice==='__new__'&&!label)throw new Error('请填写新想法名称，或选择不关联想法。');
  let parent=null;if(parentValue){try{parent=JSON.parse(parentValue);}catch{throw new Error('前序交易选择无效。');}}
  const rawAttempt=els['attempt-number'].value.trim(),attemptNumber=rawAttempt===''?null:Number(rawAttempt);
  if(attemptNumber!==null&&(!Number.isInteger(attemptNumber)||attemptNumber<1))throw new Error('尝试次数需为正整数，或留空。');
  return {thesisId:choice&&choice!=='__new__'?choice:null,newThesisLabel:choice==='__new__'?label:null,parentTradeId:parent?.tradeId||null,parentSessionId:parent?.sessionId||null,attemptNumber,strategyVersion:els['strategy-version'].value.trim()||null};
}
function commitThesis(session,context){
  if(!session||!context?.newThesisLabel)return context?.thesisId||null;
  session.theses??=[];const thesisId=context.thesisId||reviewId('thesis');if(!session.theses.some(item=>item.thesisId===thesisId))session.theses.push({thesisId,label:context.newThesisLabel,createdAt:new Date().toISOString(),actor:'user'});context.thesisId=thesisId;return thesisId;
}
function openObservation(status='judgement'){
  if(!active||pendingOrderRequest||transitionPending)return false;
  const openedAt=new Date().toISOString(),snapshotId=reviewId('snapshot'),view=reviewView(active);
  pendingOrderRequest={mode:'observation',status,sessionId:active.id,observationId:reviewId('observation'),snapshotId,captureStartedAt:openedAt,openedAt,replayMarketTime:view.visibleThrough,visibleThrough:view.visibleThrough,before:reviewStateProjection(active),view,account:reviewAccountSnapshot(active),openingScreenshot:captureReviewScreenshot(null,'observation-open')};
  reasonResumePlayback=false;reasonMode='observation';reasonSubmitting=false;reasonFocusReturn=els['observation-open'];els['entry-reason'].value='';els['observed-conditions'].value='';els['entry-reason-error'].textContent='';els['observation-status'].value=status;els['reason-confirm'].textContent='保存观察记录';els['reason-confirm'].disabled=true;els['order-reason-summary'].textContent=`${active.symbol.replace('USDT','')} · ${showTime(view.visibleThrough)} · 回放继续进行，不会暂停。`;
  populateThesisFields();setReasonCopy('observation');els['order-reason-window'].hidden=false;syncReasonControls();syncPlaybackControls();positionReasonWindow();requestAnimationFrame(()=>els['entry-reason'].focus());return true;
}
function reasonOrderSummary(p){
  const entry=p.entryPrice??p.entry,stop=Number.isFinite(p.stop)?pretty(p.stop):'未设置',take=Number.isFinite(p.take)?pretty(p.take):'未设置';
  const leverage=recordLeverage(p),margin=Number.isFinite(p.margin)?p.margin:(p.notional??0)/leverage,fee=(p.notional??0)*FEE;
  const liq=Number.isFinite(p.liquidationPrice)?p.liquidationPrice:(Number.isFinite(entry)&&entry>0&&(p.notional??0)>0?positionLiquidationPrice({side:p.side,entry,qty:(p.notional??0)/entry,margin,leverage,marginMode:'isolated-v1'}):null);
  return `${active?.symbol?.replace('USDT','')||''} · ${p.side===1?'买入 / 做多':'卖出 / 做空'} · ${p.orderType==='limit'?'限价':'市价'} · ${leverage}×逐仓\n入场 ${pretty(entry)} · 止损 ${stop} · 止盈 ${take}\n名义 ${pretty(p.notional)} U · 保证金 ${pretty(margin)} U · 开仓费 ${pretty(fee)} U · 预估强平 ${Number.isFinite(liq)?pretty(liq):'—'}`;
}
function reasonViewport(){return {width:window.innerWidth,height:window.innerHeight};}
function clampReasonWindow(x,y){
  const {width,height}=reasonViewport(),box=els['order-reason-window'];
  const maxX=Math.max(8,width-box.offsetWidth-8),maxY=Math.max(8,height-box.offsetHeight-8);
  return {x:Math.max(8,Math.min(Number(x)||0,maxX)),y:Math.max(8,Math.min(Number(y)||0,maxY))};
}
function applyReasonWindowPosition(x,y,save=false){
  const p=clampReasonWindow(x,y);reasonWindowPosition=p;els['order-reason-window'].style.left=`${p.x}px`;els['order-reason-window'].style.top=`${p.y}px`;
  if(save)try{localStorage.setItem('replay-order-reason-position-v1',JSON.stringify(p));}catch{}
}
function positionReasonWindow(){
  const box=els['order-reason-window'];let saved=null;try{saved=safeParse(localStorage.getItem('replay-order-reason-position-v1'));}catch{}
  const width=box.offsetWidth,height=box.offsetHeight,{width:vw,height:vh}=reasonViewport();
  const x=Number.isFinite(saved?.x)?saved.x:vw-width-16,y=Number.isFinite(saved?.y)?saved.y:Math.max(16,(vh-height)/2);
  applyReasonWindowPosition(x,y,false);
}
function syncReasonControls(){
  const locked=reasonBlocksReplay(),open=!!pendingOrderRequest;
  els['order-reason-window'].hidden=!open;
  els['order-reason-window'].classList.toggle('reason-open',open);
  chartOverlay?.classList.toggle('reason-frozen',locked);
  chartOverlay?.querySelectorAll('.plan-price-handle,.protection-remove,.protection-add-marker').forEach(control=>{control.disabled=locked;control.setAttribute('aria-disabled',String(locked));});
  syncDrawingControls();
  if(locked){
    els.long.disabled=true;els.short.disabled=true;$('market-type').disabled=true;$('limit-type').disabled=true;els['size-range'].disabled=true;els['leverage-range'].disabled=true;document.querySelectorAll('[data-leverage]').forEach(button=>button.disabled=true);
    document.querySelectorAll('[data-size]').forEach(button=>button.disabled=true);
    els['new-session'].disabled=true;els.symbol.disabled=true;els['confirm-plan'].disabled=true;els['cancel-plan'].disabled=true;
  }
}
function closeOrderReason(returnFocus=true){
  if(!pendingOrderRequest||reasonSubmitting)return;
  const request=pendingOrderRequest;if(request.mode==='entry'&&uiPlan){uiPlan.entryReason=els['entry-reason'].value;active.draftPlan=clone(uiPlan);persist({audit:false});}
  pendingOrderRequest=null;reasonWindowDrag=null;els['entry-reason-error'].textContent='';els['entry-reason'].removeAttribute('aria-invalid');syncReasonControls();
  if(request.mode==='exit'&&request.archiveSymbol){pendingSymbol=null;if(active)els.symbol.value=active.symbol;}
  if(active&&!invalidSavedActive)render(false,false);
  if(returnFocus&&reasonFocusReturn?.isConnected&&!reasonFocusReturn.hidden)reasonFocusReturn.focus();
  reasonFocusReturn=null;
  if(reasonBlocksReplay(request.mode))resumeReasonPlayback();else reasonResumePlayback=false;
}
function resumeReasonPlayback(){const shouldResume=reasonResumePlayback;reasonResumePlayback=false;if(shouldResume&&active&&!replayIsEnded()&&!invalidSavedActive&&!isPlaying)togglePlayWithAudit();}
async function submitOrderReason(){
  if(!pendingOrderRequest||reasonSubmitting)return;
  const entryReason=els['entry-reason'].value.trim();
  if(!entryReason){els['entry-reason'].setAttribute('aria-invalid','true');els['entry-reason-error'].textContent=`请填写${reasonMode==='exit'?'平仓':'下单'}理由后再确认。`;els['entry-reason'].focus();return;}
  if(entryReason.length>2000){els['entry-reason'].setAttribute('aria-invalid','true');els['entry-reason-error'].textContent=`${reasonMode==='exit'?'平仓':'下单'}理由不能超过 2000 个字符。`;els['entry-reason'].focus();return;}
  const lossBudgetText=els['loss-budget'].value.trim(),lossBudget=lossBudgetText===''?null:Number(lossBudgetText);
  if(pendingOrderRequest.mode==='entry'&&lossBudgetText!==''&&(!Number.isFinite(lossBudget)||lossBudget<0)){
    els['loss-budget-status'].textContent='请输入非负的USDT金额，或留空';els['loss-budget'].focus();return;
  }
  els['loss-budget-status'].textContent='';
  const request=clone(pendingOrderRequest);if(request.mode==='observation')request.openingScreenshot=pendingOrderRequest.openingScreenshot;reasonSubmitting=true;els['reason-confirm'].disabled=true;
  try{
    const thesisContext=['entry','supplement-position','supplement-after','observation'].includes(request.mode)?readThesisFields():null;
    if(thesisContext?.newThesisLabel)thesisContext.thesisId=reviewId('thesis');
    if(request.mode==='observation'){
      if(active?.id!==request.sessionId)throw new Error('本轮已变化，观察记录未保存');
      commitThesis(active,thesisContext);
      const recordedAt=new Date().toISOString(),observation={observationId:request.observationId,sessionId:active.id,status:els['observation-status'].value,
        rawText:els['entry-reason'].value,structured:null,author:'user',origin:'user',observedConditions:els['observed-conditions'].value||null,
        thesisId:thesisContext?.thesisId||null,parentTradeId:thesisContext?.parentTradeId||null,parentSessionId:thesisContext?.parentSessionId||null,
        attemptNumber:thesisContext?.attemptNumber??null,strategyVersion:thesisContext?.strategyVersion||null,openedAt:request.openedAt,recordedAt,
        replayMarketTime:request.replayMarketTime,visibleThrough:request.visibleThrough,visibleThroughSemantics:'exclusive-market-close-utc-seconds',
        snapshotId:request.snapshotId,captureStartedView:request.view,captureStartedAccount:request.account,submittedView:reviewView(active),modelConfigId:reviewModelConfigId(active),actor:'user'};
      active.observations??=[];active.observations.push(observation);const after=reviewStateProjection(active);
      pendingOrderRequest=null;reasonSubmitting=false;syncReasonControls();render();
      recordReviewEvent('observation-recorded',{before:request.before,after:{...after,observation},tradeId:observation.parentTradeId,snapshotId:request.snapshotId,thesisId:observation.thesisId,parentTradeId:observation.parentTradeId,observationId:observation.observationId,strategyVersion:observation.strategyVersion,attemptNumber:observation.attemptNumber,
        references:{thesisId:observation.thesisId,observationId:observation.observationId,parentTradeId:observation.parentTradeId},actor:'user',timingClass:observation.status,
        reason:observation.rawText,view:{...request.view,observationStatus:observation.status,recordedAt,marketTime:request.replayMarketTime},screenshot:request.openingScreenshot});
      persist({audit:false});reasonFocusReturn=null;toast(observation.status==='not-taken'?'已记录这次不做的判断':'已记录观察判断');return;
    }
    if(request.mode==='supplement-position'||request.mode==='supplement-after'){
      if(active?.id!==request.sessionId)throw new Error('本轮已变化，补充记录未保存');
      let linkedTrade=null,linkedPosition=null,captureStartedInPosition=request.mode==='supplement-position'&&request.captureStartedInPosition===true;
      if(request.mode==='supplement-position'){
        if(active.position&&positionIdentity(active.position)===request.positionId)linkedPosition=active.position;
        else linkedTrade=findClosedTradeForPosition(active.trades,request.positionSnapshot);
        if(!linkedPosition&&!linkedTrade)throw new Error('原持仓已变化，未找到对应的成交记录；补充内容未保存');
      }
      if(request.mode==='supplement-after'){
        linkedTrade=(active.trades||[]).find(item=>String(item.id||item.tradeId||item.orderId)===String(request.tradeId))||null;
        if(!linkedTrade)throw new Error('成交记录已变化，补充记录未保存');
      }
      const targetTrade=linkedTrade,effectivePlanId=targetTrade?.planId||linkedPosition?.planId||request.planId,effectiveTradeId=targetTrade?.id||targetTrade?.tradeId||targetTrade?.orderId||request.tradeId||null,effectiveOrderId=targetTrade?.orderId||linkedPosition?.orderId||request.orderId||null;
      const timingClass=request.mode==='supplement-after'||linkedTrade?'post-trade':'position';
      const submittedAt=new Date().toISOString(),plans=ensureReviewPlans(active),latest=plans.filter(item=>item.planId===effectivePlanId).sort((a,b)=>b.version-a.version)[0],submittedSnapshotId=reviewId('snapshot'),submittedView=reviewView(active),submittedAccount=reviewAccountSnapshot(active);
      const planVersion=createPlanVersion({session:active,planId:effectivePlanId,version:latest?latest.version+1:1,parentPlanId:latest?.planId||null,
        rawText:els['entry-reason'].value,structured:null,author:'user',origin:'user',timingClass,
        captureStartedAt:request.captureStartedAt,captureEndedAt:submittedAt,submittedAt,visibleThrough:replayClock(),replayMarketTime:replayClock(),snapshotId:submittedSnapshotId,
        captureStartedView:request.view,captureStartedAccount:request.account,
        orderId:effectiveOrderId,tradeId:effectiveTradeId,order:linkedPosition?clone(linkedPosition):targetTrade?clone(targetTrade):null,account:submittedAccount,captureStartedInPosition,
        thesisId:thesisContext?.thesisId||null,parentTradeId:thesisContext?.parentTradeId||null,parentSessionId:thesisContext?.parentSessionId||null,attemptNumber:thesisContext?.attemptNumber??null,strategyVersion:thesisContext?.strategyVersion||null,
        risk:{lossBudget:null,lossBudgetStatus:'not-provided',statusReason:'事后补记未设置风险预算'},modelConfigId:reviewModelConfigId(active),actor:'user'});
      commitThesis(active,thesisContext);const before=reviewStateProjection(active);appendPlanVersion(active,planVersion);
      pendingOrderRequest=null;reasonSubmitting=false;syncReasonControls();render();
      recordReviewEvent('plan-supplemented',{before,after:{...reviewStateProjection(active),planVersion},planId:planVersion.planId,orderId:planVersion.orderId,tradeId:planVersion.tradeId,snapshotId:planVersion.snapshotId,thesisId:planVersion.thesisId,parentTradeId:planVersion.parentTradeId,strategyVersion:planVersion.strategyVersion,attemptNumber:planVersion.attemptNumber,references:{captureStartedAt:request.captureStartedAt,planVersion:planVersion.version,captureStartedInPosition},actor:'user',timingClass:planVersion.timingClass,reason:planVersion.rawText,screenshot:true,view:submittedView});
      persist({audit:false});reasonFocusReturn=null;toast(planVersion.timingClass==='post-trade'?(captureStartedInPosition?'持仓期间开始的补充已作为事后版本保存':'事后复盘补充已另存为新版本'):'持仓计划补充已另存为新版本');resumeReasonPlayback();return;
    }
    if(request.mode==='exit'){
      if(active?.id!==request.sessionId||!active.position||positionIdentity(active.position)!==request.positionId)throw new Error('持仓状态已变化，未执行平仓；请取消并检查当前持仓');
      const symbol=request.symbol,side=request.side,archiveSymbol=request.archiveSymbol,trade=manualClosePosition(active,currentData(),entryReason,request.exitPrice);
      if(!trade)throw new Error('持仓已变化，未执行平仓');
      const exitRecordedAt=new Date().toISOString(),tradeId=trade.id||trade.tradeId||trade.orderId||null,afterClose=reviewStateProjection(active),closedSnapshotId=reviewId('snapshot');
      pendingOrderRequest=null;reasonSubmitting=false;clearModificationDraft();els['order-reason-window'].hidden=true;syncReasonControls();chart.priceScale('right').applyOptions({autoScale:true});render();persist({kind:'position-closed',before:request.before,after:{...afterClose,trade:clone(trade),account:reviewAccountSnapshot(active)},tradeId,orderId:trade.orderId,planId:trade.planId||request.planId,snapshotId:closedSnapshotId,references:{closeRequestSnapshotId:request.snapshotId},actor:'user',timingClass:'exit',reason:els['entry-reason'].value,view:reviewView(active),capture:true});reasonFocusReturn=null;
      const shouldResume=reasonResumePlayback;reasonResumePlayback=false;
      toast(`主动平仓已成交 · ${symbol.replace('USDT','')} ${side===1?'做多':'做空'} · ${pretty(trade.exit)} · 理由已记录`);
      if(archiveSymbol){pendingSymbol=null;const started=await startRound(archiveSymbol);if(shouldResume&&active&&!replayIsEnded()&&!invalidSavedActive&&!isPlaying)togglePlayWithAudit();if(!started)return;}
      else if(shouldResume&&active&&!replayIsEnded()&&!invalidSavedActive&&!isPlaying)togglePlayWithAudit();
      return;
    }
    const p=request;p.entryReason=entryReason;
    if(!uiPlan||active?.id!==request.sessionId)throw new Error('本轮计划已变化，订单未提交');
    uiPlan.entryReason=entryReason;uiPlan.lossBudget=lossBudget;uiPlan.reviewPlanId=p.planId;
    const frozenRisk=estimatePlanRiskSnapshot(p,replayMark(),riskModelConfig(active));
    p.riskEstimate=clone(frozenRisk);uiPlan.riskEstimate=clone(frozenRisk);active.draftPlan=clone(uiPlan);
    const submittedAt=new Date().toISOString(),snapshotId=p.snapshotId||reviewId('snapshot'),captureStartedAt=p.captureStartedAt||submittedAt,preView=reviewView(active),beforeMetrics=metrics(active,currentData());
    const account={balance:active.balance,equity:beforeMetrics.equity,availableBalance:beforeMetrics.availableBalance,usedMargin:beforeMetrics.usedMargin,reservedMargin:beforeMetrics.reservedMargin,unrealizedPnl:beforeMetrics.unreal,at:submittedAt};
    const stateBefore=reviewStateProjection(active),beforeSubmit={...stateBefore,account};
    const entryBeforeImage=captureReviewScreenshot({reviewOrder:clone(p),phase:'pre-submit-plan'},'order-plan-locked',
      {planId:p.planId,orderType:p.orderType,side:p.side,quotedPrice:p.entryPrice,reviewOrder:clone(p)});
    const metadata={planId:p.planId,lossBudget,lossBudgetStatus:lossBudget===null?'not-provided':'user-provided',rawReason:els['entry-reason'].value,modelConfigId:reviewModelConfigId(active),thesisId:thesisContext?.thesisId||null,parentTradeId:thesisContext?.parentTradeId||null,parentSessionId:thesisContext?.parentSessionId||null,attemptNumber:thesisContext?.attemptNumber??null,strategyVersion:thesisContext?.strategyVersion||null};
    const result=placeOrder(active,currentData(),p.side,p.notional,p.entryPrice,p.stop,p.take,p.orderType,entryReason,normalizeLeverage(p.leverage),metadata);
    const orderId=result.order?.id||result.position?.orderId||null;
    const tradeId=result.position?.tradeId||result.trade?.id||null;
    const estimateOrder=result.order||result.position||{};
    const riskAtSubmit=frozenRisk||estimateOrder.pretradeRisk||null;
    const planVersion=createPlanVersion({session:active,planId:p.planId,version:1,rawText:els['entry-reason'].value,structured:null,author:'user',origin:'user',timingClass:'pre-trade',captureStartedAt,captureEndedAt:submittedAt,submittedAt,visibleThrough:replayClock(),replayMarketTime:replayClock(),snapshotId,orderId,tradeId,order:{...clone(p),entryReason},account,risk:{...(riskAtSubmit||{}),lossBudget,lossBudgetStatus:lossBudget===null?'not-provided':'user-provided',lossBudgetReason:lossBudget===null?'用户未填写亏损预算':null,plannedPriceRisk:Number.isFinite(riskAtSubmit?.priceRisk)?riskAtSubmit.priceRisk:null,plannedRiskIncludingCosts:Number.isFinite(riskAtSubmit?.netStopRisk)?riskAtSubmit.netStopRisk:Number.isFinite(riskAtSubmit?.plannedRiskIncludingCosts)?riskAtSubmit.plannedRiskIncludingCosts:null,plannedRiskUnavailableReason:riskAtSubmit?'': '风险模型暂不可用',initialStop:p.stop??null,initialTake:p.take??null},modelConfigId:reviewModelConfigId(active),actor:'user',thesisId:thesisContext?.thesisId||null,parentTradeId:thesisContext?.parentTradeId||null,parentSessionId:thesisContext?.parentSessionId||null,attemptNumber:thesisContext?.attemptNumber??null,strategyVersion:thesisContext?.strategyVersion||null});
    commitThesis(active,thesisContext);appendPlanVersion(active,planVersion);
    const planBefore={...beforeSubmit,planVersion:null},planAfter={...beforeSubmit,planVersion};
    recordReviewEvent('order-plan-locked',{before:planBefore,after:planAfter,view:preView,orderId,tradeId,planId:p.planId,snapshotId,thesisId:planVersion.thesisId,parentTradeId:planVersion.parentTradeId,strategyVersion:planVersion.strategyVersion,attemptNumber:planVersion.attemptNumber,actor:'user',timingClass:'pre-trade',reason:planVersion.rawText,screenshot:entryBeforeImage});
    pendingOrderRequest=null;reasonSubmitting=false;uiPlan=null;active.draftPlan=null;els['plan-actions'].hidden=true;els['order-reason-window'].hidden=true;syncReasonControls();chart.priceScale('right').applyOptions({autoScale:true});render();
    const afterMetrics=metrics(active,currentData()),afterSubmit={...reviewStateProjection(active),account:{balance:active.balance,equity:afterMetrics.equity,availableBalance:afterMetrics.availableBalance,usedMargin:afterMetrics.usedMargin,reservedMargin:afterMetrics.reservedMargin,unrealizedPnl:afterMetrics.unreal},initialOrder:clone(result.order||result.position||null),entryReason,planVersion};
    const submittedSnapshotId=reviewId('snapshot');
    persist({kind:'order-submitted',before:planAfter,after:afterSubmit,orderId,orderType:p.orderType,planId:p.planId,snapshotId:submittedSnapshotId,thesisId:planVersion.thesisId,parentTradeId:planVersion.parentTradeId,strategyVersion:planVersion.strategyVersion,attemptNumber:planVersion.attemptNumber,actor:'user',timingClass:'pre-trade',reason:planVersion.rawText,references:{planId:p.planId,preSubmitSnapshotId:snapshotId},annotation:{reviewOrder:clone(result.order||result.position||p),phase:result.status==='pending'?'submitted-pending':'submitted-filled'},capture:true});
    if(result.status==='filled')recordReviewEvent('order-filled',{before:planAfter,after:{...afterSubmit,event:{order:clone(result.order||null),position:clone(result.position||null)}},orderId,tradeId,planId:p.planId,snapshotId:reviewId('snapshot'),thesisId:planVersion.thesisId,parentTradeId:planVersion.parentTradeId,strategyVersion:planVersion.strategyVersion,attemptNumber:planVersion.attemptNumber,references:{planId:p.planId,preSubmitSnapshotId:snapshotId,submitSnapshotId:submittedSnapshotId},orderType:p.orderType,actor:'engine',timingClass:'fill',screenshot:true});
    reasonFocusReturn=null;
    const coin=active.symbol.replace('USDT',''),direction=p.side===1?'做多':'做空',fill=result.position?.entry??result.order?.fillPrice??p.entryPrice;
    if(result.status==='pending')toast(`限价单已挂单 · ${coin} ${direction} · 限价 ${pretty(p.entryPrice)}`);
    else if(p.orderType==='limit')toast(`限价单已成交 · ${coin} ${direction} · 成交 ${pretty(fill)}`);
    else toast(`市价单已成交 · ${coin} ${direction} · 成交 ${pretty(fill)}`);
    resumeReasonPlayback();
  }catch(error){reasonSubmitting=false;els['reason-confirm'].disabled=false;els['entry-reason-error'].textContent=error.message||'操作未完成，请检查后重试。';els['entry-reason'].setAttribute('aria-invalid','true');els['entry-reason'].focus();syncReasonControls();}
}
function entryReasonText(value){return typeof value==='string'&&value.trim()?value:'未记录';}
function exitReasonText(value){return typeof value==='string'&&value.trim()?value:'未记录';}
function dragReasonWindowStart(event){
  if(event.button!==0||event.target.closest('button,input,textarea,select,a'))return;
  const box=els['order-reason-window'],rect=box.getBoundingClientRect();reasonWindowDrag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:rect.left,top:rect.top};
  event.preventDefault();els['order-reason-drag'].setPointerCapture(event.pointerId);
}
function dragReasonWindowMove(event){
  if(!reasonWindowDrag||reasonWindowDrag.pointerId!==event.pointerId)return;
  applyReasonWindowPosition(reasonWindowDrag.left+event.clientX-reasonWindowDrag.startX,reasonWindowDrag.top+event.clientY-reasonWindowDrag.startY,false);
}
function dragReasonWindowEnd(event){
  if(!reasonWindowDrag||reasonWindowDrag.pointerId!==event.pointerId)return;
  const drag=reasonWindowDrag;reasonWindowDrag=null;
  if(els['order-reason-drag'].hasPointerCapture(event.pointerId))els['order-reason-drag'].releasePointerCapture(event.pointerId);
  applyReasonWindowPosition(reasonWindowPosition?.x??drag.left,reasonWindowPosition?.y??drag.top,true);
}
function cancelDraft(){if(pendingOrderRequest)return;uiPlan=null;if(active)active.draftPlan=null;els['plan-actions'].hidden=true;chart.priceScale('right').applyOptions({autoScale:true});render();persist();}
function locatePlanPrices(){chart.priceScale('right').applyOptions({autoScale:true});chart.timeScale().scrollToRealTime();renderPlanOverlay();}
function disclosedBars(){
  if(!active)return [];
  return aggregateReplay(active,currentData(),active.tf,Math.max(0,active.start-Math.ceil(WARMUP/BASE)));
}
function computeMa(bars,period=20){let sum=0;return bars.map((bar,i)=>{sum+=bar.close;if(i>=period)sum-=bars[i-period].close;return i>=period-1?{time:bar.time,value:sum/period}:null;}).filter(Boolean);}
function maSignature(){return active?`${active.id}|${active.symbol}|${active.tf}|${active.cursor}|${active.minuteCursorTime??''}`:'';}
function effectivePlan(){return dragDraft||uiPlan||modificationDraft||active?.pending||active?.position||null;}
function getPlanLevels(){if(frozenPlanLevels)return frozenPlanLevels;const p=effectivePlan();return p?[p.entryPrice??p.entry,p.stop,p.take].filter(Number.isFinite):[];}
function riskModelConfig(session=active){return session?.modelConfigs?.find(item=>item?.modelConfigId===session.modelConfigId)||null;}
function estimatePlanRiskSnapshot(plan,currentPrice,modelConfig=null,estimator=estimateOrderRisk){
  if(!plan||!Number.isFinite(currentPrice)||currentPrice<=0||typeof estimator!=='function')return null;
  const entryPrice=plan.entryPrice??plan.entry;
  try{return estimator({side:plan.side,notional:plan.notional,currentPrice,entryPrice,
    stop:plan.stop??null,take:plan.take??null,orderType:plan.orderType==='market'?'market':'limit',modelConfig});}
  catch{return null;}
}
function riskPreviewRows(risk,lossBudget=null){
  const amount=(value,unavailableReason)=>Number.isFinite(value)?`${Number(value).toFixed(2)} U`:risk===null||unavailableReason?'暂不可计算':'未设置';
  return [
    ['价格差风险',amount(risk?.priceRisk,risk?.priceRiskUnavailableReason)],
    ['预计止损净损失',amount(risk?.netStopRisk,risk?.netStopRiskUnavailableReason)],
    ['用户亏损预算',Number.isFinite(lossBudget)?`${lossBudget.toFixed(2)} U`:'' ],
    ['预计止盈净收益',amount(risk?.expectedTakeProfitNet,risk?.expectedTakeProfitNetUnavailableReason)],
    ['净盈亏比',Number.isFinite(risk?.netRewardRisk)?`${risk.netRewardRisk.toFixed(2)}:1`:risk===null||risk?.netRewardRiskUnavailableReason?'暂不可计算':'未设置']
  ];
}
function syncPlanSummary(){
  renderLeverageEstimates();
  const p=effectivePlan(),isDraft=!!uiPlan;
  if(els['plan-actions'])els['plan-actions'].hidden=!isDraft;
  if(!p){els['risk-preview'].textContent='—';$('risk-preview-label').textContent='本笔风险估算';return;}
  const entry=p.entryPrice??p.entry,side=p.side;
  let risk=uiPlan?estimatePlanRiskSnapshot(uiPlan,replayMark(),riskModelConfig(active)):
    (active?.pending?.pretradeRisk||active?.position?.pretradeRisk||null);
  if(risk&&!risk.riskCalculationVersion)risk={...risk,netStopRisk:null,netStopRiskUnavailableReason:'旧记录没有成本估算',expectedTakeProfitNet:null,expectedTakeProfitNetUnavailableReason:'旧记录没有成本估算',netRewardRisk:null,netRewardRiskUnavailableReason:'旧记录没有成本估算'};
  $('risk-preview-label').textContent=active?.position?'成交时初始风险（已锁定）':active?.pending?'挂单计划估算':uiPlan?'下单预估':'本笔风险估算';
  const storedBudget=p.lossBudget??p.riskBudget?.lossBudget;
  const lossBudget=Number.isFinite(storedBudget)?storedBudget:(isDraft&&els['loss-budget']?.value.trim()!==''?Number(els['loss-budget'].value):null);
  els['risk-preview'].replaceChildren();
  for(const [label,value] of riskPreviewRows(risk,lossBudget)){
    const row=document.createElement('div'),name=document.createElement('span'),amount=document.createElement('strong');
    row.className='risk-preview-row';name.textContent=label;amount.textContent=value;row.append(name,amount);els['risk-preview'].append(row);
  }
  if(isDraft){const stopValid=p.stop===null||validProtection(side,'stop',p.stop,entry),takeValid=p.take===null||validProtection(side,'take',p.take,entry),valid=entry>0&&stopValid&&takeValid&&Number(els.notional.value)>0;els['confirm-plan'].disabled=!valid||!!pendingOrderRequest;els['confirm-plan'].textContent=p.orderType==='limit'?`提交限价单 · ${side===1?'买入 / 做多':'卖出 / 做空'}`:`确认市价 · ${side===1?'买入 / 做多':'卖出 / 做空'}`;els['plan-hint'].textContent=p.orderType==='limit'?'点图选价；限价按指定价或更优成交，未触价时等待后续行情。图上的「＋止损」「＋止盈」可单独拖出。':'市价按当前回放收盘价成交。图上的「＋止损」「＋止盈」可单独拖出；拖动线可调整。';els['locate-plan'].hidden=false;}
}
function renderPlanOverlay(){
  if(overlayFrame)cancelAnimationFrame(overlayFrame);
  overlayFrame=requestAnimationFrame(()=>{overlayFrame=0;renderPlanOverlayNow();syncPlanOverlayCoordinates();schedulePlanProjection();});
}
function renderPlanOverlayNow(){
  if(!chartOverlay||!chart||!candleSeries)return;
  chartOverlay.replaceChildren();const p=effectivePlan();if(!p){syncPlanSummary();return;}
  const movableEntry=uiPlan?.orderType==='limit'||!!active?.pending;
  const editingExisting=!!modificationDraft&&!uiPlan;
  const entry=p.entryPrice??p.entry,prices=[['entry',entry,'入场价',movableEntry]];
  for(const [kind,label] of [['stop','止损'],['take','止盈']])if(Number.isFinite(p[kind]))prices.push([kind,p[kind],label,true]);
  const host=$('chart'),plotWidth=Math.max(0,host.clientWidth-66);
  for(const [key,price,label,movable] of prices){
    if(!Number.isFinite(price))continue;
    const y=candleSeries.priceToCoordinate(price);const initialY=Number.isFinite(y)?y:0;
    const previewing=dragState?.adding&&dragState.kind===key;
    const baseValue=modificationDraft?._edit?.base?.[key==='entry'?'entryPrice':key];const valueChanged=editingExisting&&price!==baseValue;
    const line=document.createElement('div');line.className=`plan-price-line ${key}${movable?'':' locked'}${previewing?' preview':''}${valueChanged?' modification-preview':''}`;line.dataset.kind=key;line.style.top=`${initialY}px`;line.style.right='66px';line.hidden=!Number.isFinite(y);
    const tag=document.createElement('span');tag.className=`plan-price-label ${key}${movable?'':' locked'}${previewing?' preview':''}${valueChanged?' modification-preview':''}`;tag.dataset.kind=key;tag.textContent=`${label}  ${pretty(price)}${valueChanged?' · 待确认':''}`;tag.style.top=`${Math.max(1,initialY-13)}px`;tag.style.right='70px';tag.hidden=!Number.isFinite(y);
    if(movable){const handle=document.createElement('button');handle.type='button';handle.className='plan-price-handle';handle.dataset.kind=key;handle.style.top=`${initialY}px`;handle.style.left=`${Math.max(4,plotWidth-11)}px`;handle.setAttribute('role','slider');handle.setAttribute('aria-label',`拖动${label}价格线`);handle.setAttribute('aria-valuenow',String(price));handle.title=`${label} ${pretty(price)} · 方向键微调`;handle.hidden=!Number.isFinite(y);handle.disabled=!!pendingOrderRequest;handle.setAttribute('aria-disabled',String(!!pendingOrderRequest));
      handle.addEventListener('keydown',event=>{if(pendingOrderRequest||activeDrawingTool||!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();pauseForChartEdit();if(!uiPlan){ensureModificationDraft();renderPosition();}dragState={kind:key};dragDraft=clone(effectivePlan());const step=Math.max(price*0.0001,0.01);updatePlanDraft(key,price+(event.key==='ArrowUp'?step:-step));commitPlanDraft();});chartOverlay.append(line,tag,handle);
      if(key!=='entry'){
        const remove=document.createElement('button');remove.type='button';remove.className=`protection-remove ${key}`;remove.dataset.kind=key;remove.textContent='×';remove.setAttribute('aria-label',`取消${label}`);remove.title=`取消${label}`;remove.style.top=`${initialY}px`;remove.hidden=!Number.isFinite(y);remove.disabled=!!pendingOrderRequest;remove.setAttribute('aria-disabled',String(!!pendingOrderRequest));chartOverlay.append(remove);
      }
    }else chartOverlay.append(line,tag);
  }
  for(const [kind,label,gapFromRight] of [['stop','止损',320],['take','止盈',220]])if(p[kind]===null){
    const y=candleSeries.priceToCoordinate(entry),marker=document.createElement('button');marker.type='button';marker.className=`protection-add-marker ${kind}`;marker.dataset.kind=kind;marker.textContent=`＋${label}`;marker.setAttribute('aria-label',`拖动以添加${label}`);marker.title=`按住并向${p.side===1?(kind==='stop'?'下':'上'):(kind==='stop'?'上':'下')}拖动，设置${label}`;marker.style.top=`${Number.isFinite(y)?y:0}px`;marker.style.left=`${Math.max(8,plotWidth-gapFromRight)}px`;marker.hidden=!Number.isFinite(y);marker.disabled=!!pendingOrderRequest;marker.setAttribute('aria-disabled',String(!!pendingOrderRequest));chartOverlay.append(marker);
  }
  syncPlanSummary();
}
function syncPlanOverlayCoordinates(){
  if(!chartOverlay||!chart||!candleSeries)return;
  const p=effectivePlan();if(!p){if(projectionFrame)cancelAnimationFrame(projectionFrame);projectionFrame=0;return;}
  const entry=p.entryPrice??p.entry,levels={entry,stop:p.stop,take:p.take};
  for(const [kind,price] of Object.entries(levels)){
    const y=Number.isFinite(price)?candleSeries.priceToCoordinate(price):null;
    const line=chartOverlay.querySelector(`.plan-price-line[data-kind="${kind}"]`);
    const tag=chartOverlay.querySelector(`.plan-price-label[data-kind="${kind}"]`);
    const handle=chartOverlay.querySelector(`.plan-price-handle[data-kind="${kind}"]`);
    for(const el of [line,tag,handle])if(el)el.hidden=y===null||!Number.isFinite(y);
    if(y===null||!Number.isFinite(y))continue;
    if(line){line.style.top=`${y}px`;const keyName=kind==='entry'?'entryPrice':kind,based=modificationDraft?._edit?.base?.[keyName],changed=!!modificationDraft&&!uiPlan&&price!==based;line.classList.toggle('modification-preview',changed);}
    if(tag){tag.style.top=`${Math.max(1,y-13)}px`;const key=kind==='entry'?'entryPrice':kind,based=modificationDraft?._edit?.base?.[key],changed=!!modificationDraft&&!uiPlan&&price!==based;tag.textContent=`${kind==='entry'?'入场价':kind==='stop'?'止损':'止盈'}  ${pretty(price)}${changed?' · 待确认':''}`;tag.classList.toggle('modification-preview',changed);}
    if(handle){handle.style.top=`${y}px`;handle.setAttribute('aria-valuenow',String(price));}
    const remove=chartOverlay.querySelector(`.protection-remove[data-kind="${kind}"]`);if(remove){remove.hidden=y===null||!Number.isFinite(y);remove.style.top=`${y}px`;}
  }
  const entryY=candleSeries.priceToCoordinate(entry),plotWidth=Math.max(0,$('chart').clientWidth-66);for(const marker of chartOverlay.querySelectorAll('.protection-add-marker')){marker.hidden=entryY===null||!Number.isFinite(entryY);if(!marker.hidden){marker.style.top=`${entryY}px`;marker.style.left=`${Math.max(8,plotWidth-(marker.classList.contains('take')?220:320))}px`;}}
}
function schedulePlanProjection(){
  if(projectionFrame||!effectivePlan())return;
  projectionFrame=requestAnimationFrame(()=>{projectionFrame=0;syncPlanOverlayCoordinates();if(effectivePlan())schedulePlanProjection();});
}
function setupPlanOverlayEvents(){
  chartOverlay.addEventListener('pointerdown',event=>{if(pendingOrderRequest||activeDrawingTool)return;if(event.target.closest('.protection-remove')){event.preventDefault();event.stopPropagation();return;}const target=event.target.closest('.plan-price-handle,.plan-price-label,.plan-price-line,.protection-add-marker');if(!target||target.classList.contains('locked'))return;event.preventDefault();event.stopPropagation();pauseForChartEdit();if(!uiPlan){ensureModificationDraft();syncPlaybackControls();}dragDraft=clone(effectivePlan());frozenPlanLevels=getPlanLevels();dragState={kind:target.dataset.kind,adding:target.classList.contains('protection-add-marker'),startY:event.clientY};chartOverlay.setPointerCapture(event.pointerId);});
  chartOverlay.addEventListener('pointermove',event=>{if(pendingOrderRequest||activeDrawingTool||!dragState)return;event.preventDefault();event.stopPropagation();const rect=$('chart').getBoundingClientRect(),value=candleSeries.coordinateToPrice(event.clientY-rect.top);if(!Number.isFinite(value)||value<=0)return;if(dragState.adding){const moved=Math.abs(event.clientY-dragState.startY)>=6;dragDraft[dragState.kind]=moved&&protectionPreviewValid(dragState.kind,value,dragDraft)?value:null;renderPlanOverlay();}else updatePlanDraft(dragState.kind,value);if(modificationDraft&&els.position.querySelector('.modification-confirmation'))renderModificationPanel(els.position,false);});
  chartOverlay.addEventListener('pointerup',event=>{if(pendingOrderRequest||activeDrawingTool||!dragState)return;event.preventDefault();event.stopPropagation();if(chartOverlay.hasPointerCapture(event.pointerId))chartOverlay.releasePointerCapture(event.pointerId);if(dragState.adding&&!Number.isFinite(dragDraft?.[dragState.kind])){dragState=null;dragDraft=null;frozenPlanLevels=null;if(!modificationChanged())modificationDraft=null;renderPlanOverlay();renderPosition();syncPlaybackControls();return;}commitPlanDraft();});
  chartOverlay.addEventListener('pointercancel',()=>{dragState=null;dragDraft=null;frozenPlanLevels=null;if(!modificationChanged())modificationDraft=null;chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();renderPosition();syncPlaybackControls();});
  chartOverlay.addEventListener('click',event=>{if(pendingOrderRequest||activeDrawingTool)return;const target=event.target.closest('.protection-remove');if(!target)return;event.preventDefault();event.stopPropagation();removeProtection(target.dataset.kind);});
}
function pauseForChartEdit(){}
function setPlanEntry(price){if(pendingOrderRequest||!uiPlan)return;const old=uiPlan.entryPrice,stopPct=Number.isFinite(uiPlan.stop)?Math.abs(old-uiPlan.stop)/old:null,takePct=Number.isFinite(uiPlan.take)?Math.abs(uiPlan.take-old)/old:null;uiPlan.entryPrice=price;uiPlan.stop=stopPct===null?null:price*(1-uiPlan.side*stopPct);uiPlan.take=takePct===null?null:price*(1+uiPlan.side*takePct);active.draftPlan=clone(uiPlan);chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();persist();}
function updatePlanDraft(kind,value){
  if(pendingOrderRequest)return;
  const target=dragDraft||uiPlan;if(!target)return;
  const entry=target.entryPrice??target.entry,anchor=active?.position&&!uiPlan&&!active?.pending?(replayMark()??entry):entry,epsilon=Math.max(anchor*1e-6,0.01);
  if(kind==='entry'){const delta=value-entry;if('entryPrice'in target)target.entryPrice=value;else target.entry=value;if(Number.isFinite(target.stop))target.stop+=delta;if(Number.isFinite(target.take))target.take+=delta;}
  else if(kind==='stop')target.stop=target.side===1?Math.min(value,anchor-epsilon):Math.max(value,anchor+epsilon);
  else target.take=target.side===1?Math.max(value,anchor+epsilon):Math.min(value,anchor-epsilon);
  syncPlanOverlayCoordinates();
}
function removeProtection(kind){
  if(pendingOrderRequest||!['stop','take'].includes(kind)||!active)return;
  const p=effectivePlan();if(!p||!Number.isFinite(p[kind]))return;
  pauseForChartEdit();
  try{
    if(uiPlan){uiPlan[kind]=null;active.draftPlan=clone(uiPlan);persist();}
    else{const draft=ensureModificationDraft();if(!draft)return;draft[kind]=null;renderPosition();syncPlaybackControls();}
    chart.priceScale('right').applyOptions({autoScale:true});render(false,false);
  }catch(error){toast(error.message||`无法取消${kind==='stop'?'止损':'止盈'}`);render(false,false);}
}
function commitPlanDraft(){
  if(pendingOrderRequest||!dragState)return;
  dragState=null;let updateResult=null;frozenPlanLevels=null;
  try{
    if(uiPlan){uiPlan=clone(dragDraft);active.draftPlan=clone(uiPlan);dragDraft=null;persist();}
    else if(active?.pending||active?.position){const candidate=clone(dragDraft);dragDraft=null;if(!modificationChanged(candidate)){modificationDraft=null;}else modificationDraft=candidate;renderPosition();syncPlaybackControls();}
    chart.priceScale('right').applyOptions({autoScale:true});render(false,false);
  }catch(error){dragDraft=null;toast(error.message||'价格线调整未通过校验');renderPlanOverlay();}
}
function initChart(){
  const host=$('chart');
  chart=createChart(host,{width:host.clientWidth||800,height:host.clientHeight||418,layout:{background:{type:ColorType.Solid,color:'#171b1e'},textColor:'#879397',fontFamily:'Inter, -apple-system, sans-serif',fontSize:12},grid:{vertLines:{color:'#22292c'},horzLines:{color:'#22292c'}},crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#566469',labelBackgroundColor:'#39474b'},horzLine:{color:'#566469',labelBackgroundColor:'#39474b'}},rightPriceScale:{borderColor:'#313a3d',scaleMargins:{top:.08,bottom:.23}},timeScale:{borderColor:'#313a3d',timeVisible:true,secondsVisible:false,tickMarkFormatter:(time)=>formatChartTime(time),rightOffset:4,barSpacing:7},localization:{locale:'zh-CN',timeFormatter:(time)=>formatChartTime(time),priceFormatter:(price)=>pretty(price,2)}});
  candleSeries=chart.addSeries(CandlestickSeries,{upColor:'#22c58b',downColor:'#f06d78',borderUpColor:'#22c58b',borderDownColor:'#f06d78',wickUpColor:'#22c58b',wickDownColor:'#f06d78',priceLineVisible:false,autoscaleInfoProvider:original=>{const info=original?.();if(!info?.priceRange)return info;const levels=getPlanLevels();if(!levels.length)return info;return {...info,priceRange:{minValue:Math.min(info.priceRange.minValue,...levels),maxValue:Math.max(info.priceRange.maxValue,...levels)}};}});
  maSeries=chart.addSeries(LineSeries,{color:'#e6ba69',lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});
  ma10Series=chart.addSeries(LineSeries,{color:'#65a9ff',lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});
  volumeSeries=chart.addSeries(HistogramSeries,{priceScaleId:'review-volume',priceFormat:{type:'volume'},base:0,priceLineVisible:false,lastValueVisible:false});
  chart.priceScale('review-volume').applyOptions({scaleMargins:{top:.79,bottom:.02},visible:false,autoScale:true});
  chart.subscribeCrosshairMove(param=>{if(!active||!param.time)return;const bar=param.seriesData.get(candleSeries);if(!bar)return;const vol=param.seriesData.get(volumeSeries);els['ohlc'].textContent=`${showTime(Number(param.time))}  O ${pretty(bar.open)}  H ${pretty(bar.high)}  L ${pretty(bar.low)}  C ${pretty(bar.close)}`;if(vol)els['volume-value'].textContent=`VOL ${pretty(vol.value,4)} ${active.symbol.replace(/USDT$/,'')}`;});
  chart.subscribeClick(param=>{if(drawingTools?.consumeChartClick())return;if(pendingOrderRequest||activeDrawingTool||!uiPlan||uiPlan.orderType!=='limit'||!param.point||!chartOverlay)return;const rect=host.getBoundingClientRect(),y=param.point.y;if(y<0||y>rect.height-28)return;const price=candleSeries.coordinateToPrice(y);if(Number.isFinite(price)&&price>0)setPlanEntry(price);});
  chartOverlay=document.createElement('div');chartOverlay.className='price-line-overlay';chartOverlay.setAttribute('aria-label','入场与风险价格线');host.append(chartOverlay);
  drawingTools=createDrawingTools({chart,series:candleSeries,container:host,getSession:()=>active,getBars:()=>disclosedBars(),getInterval:()=>active?.tf??BASE,formatPrice:price=>pretty(price),onChange:()=>{const before=reviewStateProjection(active),oldDrawings=drawingAuditSnapshot??clone(active?.drawings||[]),nextDrawings=clone(active?.drawings||[]),oldIds=new Set(oldDrawings.map(x=>x?.id)),nextIds=new Set(nextDrawings.map(x=>x?.id));const kind=[...nextIds].some(id=>!oldIds.has(id))?'drawing-created':[...oldIds].some(id=>!nextIds.has(id))?'drawing-deleted':'drawing-modified';before.drawings=oldDrawings;drawingAuditSnapshot=nextDrawings;render();persist({kind,before,capture:true});syncDrawingControls();},onStateChange:state=>{activeDrawingTool=state.tool;selectedDrawingId=state.selectedId;chartOverlay?.classList.toggle('drawing-disabled',!!state.tool);syncDrawingControls();if($('drawing-hint'))$('drawing-hint').textContent=state.tool==='trendline'?(state.phase==='end'?'点击终点完成趋势线':'点击起点，然后移动鼠标预览并点击终点'):state.tool==='zone'?(state.phase==='end'?'移动预览区域，点击对角完成':'点击区域第一角，再移动并点击对角'):state.tool==='horizontal'?'点图放置水平线，或悬停价格轴旁＋':'悬停价格轴旁＋绘制水平线；趋势线完成后可拖动，区域可拖动边角';},isLocked:()=>!!pendingOrderRequest||!!transitionPending});
  setupPlanOverlayEvents();
  resizeObserver=new ResizeObserver(entries=>{const box=entries[0]?.contentRect;if(box){chart.applyOptions({width:box.width,height:box.height});renderPlanOverlay();}});resizeObserver.observe(host);
  chart.timeScale().subscribeVisibleLogicalRangeChange(syncPlanOverlayCoordinates);
  chart.timeScale().subscribeVisibleTimeRangeChange(syncPlanOverlayCoordinates);
  host.addEventListener('pointermove',syncPlanOverlayCoordinates,{passive:true});
  host.addEventListener('wheel',syncPlanOverlayCoordinates,{passive:true});
}
function formatChartTime(time){const epoch=typeof time==='number'?time:time?.timestamp;if(!Number.isFinite(epoch))return '';return active?.blind?relativeTime(epoch):utcDate(epoch);}
function renderChart(fit=false,resetRange=false){
  if(!active||!candleSeries)return;
  const bars=disclosedBars();
  // Only disclosed candles are sent to the chart; no future whitespace/data points are created.
  candleSeries.setData(bars.map(b=>({time:b.time,open:b.open,high:b.high,low:b.low,close:b.close})));
  volumeSeries.setData(bars.map(b=>({time:b.time,value:Number.isFinite(b.volume)?b.volume:0,color:b.close>=b.open?'#22c58b99':'#f06d7899'})));
  volumeSeries.applyOptions({visible:active.volume!==false});
  drawingTools?.refresh(bars);
  const key=maSignature();
  if(maDataKey!==key){maSeries.setData(computeMa(bars));maDataKey=key;}
  if(ma10DataKey!==key){ma10Series.setData(computeMa(bars,10));ma10DataKey=key;}
  maSeries.applyOptions({visible:!!active.ma});
  ma10Series.applyOptions({visible:!!active.ma10});
  chart.applyOptions({localization:{timeFormatter:time=>formatChartTime(time)}});
  if(fit)chart.timeScale().fitContent();
  else if(resetRange&&bars.length){const visible=active.tf===604800?52:120;chart.timeScale().setVisibleLogicalRange({from:Math.max(0,bars.length-visible),to:bars.length+3});}
  renderPlanOverlay();
  updateQuote(bars.at(-1));
}
function updateQuote(bar){
  if(!active||!bar){els['last-price'].textContent='—';return;}
  const previous=disclosedBars().at(-2),change=previous?(bar.close/previous.close-1)*100:0;
  els['last-price'].textContent=pretty(bar.close);
  els['last-change'].textContent=`${change>=0?'+':''}${pretty(change)}%`;
  els['last-change'].className=change>=0?'positive':'negative';
  els['volume-value'].textContent=`VOL ${pretty(bar.volume,4)} ${active.symbol.replace(/USDT$/,'')}`;
  els.ohlc.textContent=`${showTime(bar.time)}  O ${pretty(bar.open)}  H ${pretty(bar.high)}  L ${pretty(bar.low)}  C ${pretty(bar.close)}`;
}
function putCell(row,text,className=''){const cell=document.createElement('td');cell.textContent=text;if(className)cell.className=className;row.append(cell);return cell;}
function showPlanHistory(session,record){
  const dialog=$('plan-history-dialog'),body=$('plan-history-body');body.replaceChildren();
  const linked=(session?.reviewPlans||[]).filter(plan=>(record?.planId&&plan.planId===record.planId)||(record?.tradeId&&plan.tradeId===record.tradeId)||(record?.id&&plan.tradeId===record.id)||(record?.orderId&&plan.orderId===record.orderId)||(record?.orderId&&plan.tradeId===record.orderId));
  const allSessions=[active,...history.map(item=>item?.session),session].filter(Boolean);
  const ideaLabel=id=>{if(!id)return '未关联想法';for(const owner of allSessions){const item=(owner.theses||[]).find(thesis=>String(thesis.thesisId)===String(id));if(item)return item.label||'未命名想法';}return `想法记录未随本轮导入（${String(id).slice(-8)}）`;};
  const parentLabel=(id,parentSessionId)=>{if(!id)return '无前序交易';for(const owner of allSessions){if(parentSessionId&&String(owner.id)!==String(parentSessionId))continue;const trade=(owner.trades||[]).find(item=>[item.tradeId,item.id,item.orderId].some(key=>key&&String(key)===String(id)));if(trade)return `${owner.symbol?.replace('USDT','')||''} ${trade.side===1?'多':'空'} · ${trade.entryTime?showTime(trade.entryTime,owner.blind,owner):'时间未知'} · #${String(id).slice(-8)}`;}return `前序交易未找到（${String(id).slice(-8)}）`;};
  const sorted=linked.sort((a,b)=>(a.version||0)-(b.version||0));
  if(!sorted.length){const empty=document.createElement('p');empty.textContent='这笔交易没有可确认的计划版本；不会用事后记录补写事前计划。';body.append(empty);}
  for(const plan of sorted){const article=document.createElement('article');article.className='plan-version-card';const heading=document.createElement('strong');heading.textContent=`版本 ${plan.version||'—'} · ${plan.timingClass==='pre-trade'?'下单前':plan.timingClass==='post-trade'?'平仓后补记':'持仓中补充'} · ${plan.recordedAt?showTime(Date.parse(plan.recordedAt)/1000,false):'时间未知'}`;const text=document.createElement('p');text.textContent=plan.rawText||'（空记录）';const context=document.createElement('small');const risk=plan.risk?.lossBudget===null?'亏损预算未填写':Number.isFinite(plan.risk?.lossBudget)?`亏损预算 ${pretty(plan.risk.lossBudget)} U`:'无风险预算信息';context.textContent=[ideaLabel(plan.thesisId),parentLabel(plan.parentTradeId,plan.parentSessionId),Number.isInteger(plan.attemptNumber)?`第 ${plan.attemptNumber} 次`:'未记次数',plan.strategyVersion||'无策略标签',plan.captureStartedInPosition?'开窗时有持仓':'',risk].filter(Boolean).join(' · ');article.append(heading,text,context);body.append(article);}
  $('plan-history-title').textContent=`计划版本 · ${record?.side===1?'做多':'做空'} · ${session?.symbol?.replace('USDT','')||''}`;if(!dialog.open)dialog.showModal();
}
function renderTradeTable(trades,symbol,session){
  if(!trades.length){const empty=document.createElement('div');empty.className='empty-journal';empty.textContent='还没有已平仓成交。开仓后推进行情，或手动平仓记录结果。';els['journal-content'].append(empty);return;}
  const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table');
  const thead=document.createElement('thead'),hr=document.createElement('tr');['方向','杠杆 / 保证金','开仓时间','开仓价','入场理由','平仓时间','平仓价','盈亏 USDT','逐仓补差','人工平仓理由','平仓原因','计划版本'].forEach(t=>{const th=document.createElement('th');th.textContent=t;hr.append(th);});thead.append(hr);table.append(thead);
  const body=document.createElement('tbody');
  for(const t of [...trades].reverse()){
    const tr=document.createElement('tr');putCell(tr,`${symbol.replace('USDT','')} ${t.side===1?'做多':'做空'}`,t.side===1?'positive':'negative');
    putCell(tr,leverageMarginText(t),'num');putCell(tr,showTime(t.entryTime,session?.blind,session),'num');putCell(tr,pretty(t.entry),'num');putCell(tr,entryReasonText(t.entryReason),'entry-reason-cell');putCell(tr,showTime(t.exitTime,session?.blind,session),'num');putCell(tr,pretty(t.exit),'num');putCell(tr,pretty(t.pnl),`num ${t.pnl>=0?'positive':'negative'}`);putCell(tr,Number.isFinite(t.isolatedAdjustment)&&t.isolatedAdjustment!==0?`${t.isolatedAdjustment>0?'+':''}${pretty(t.isolatedAdjustment)} U`:'—','num');putCell(tr,t.reason==='手动平仓'?exitReasonText(t.exitReason):'—','exit-reason-cell');putCell(tr,t.reason||'—');const reviewCell=document.createElement('td'),planButton=document.createElement('button');planButton.type='button';planButton.className='quiet';planButton.textContent='计划版本';planButton.addEventListener('click',event=>{event.stopPropagation();showPlanHistory(session,t);});reviewCell.append(planButton);const reviewButton=document.createElement('button');reviewButton.type='button';reviewButton.className='quiet';reviewButton.textContent=session?.id===active?.id?'补充复盘':'只读归档';reviewButton.disabled=session?.id!==active?.id;reviewButton.addEventListener('click',event=>{event.stopPropagation();if(session?.id===active?.id)requestPlanSupplement({trade:t,returnFocus:reviewButton});});reviewCell.append(reviewButton);tr.append(reviewCell);body.append(tr);
  }
  table.append(body);wrap.append(table);els['journal-content'].append(wrap);
}
function renderJournal(){
  els['journal-content'].replaceChildren();
  els['journal-count'].textContent=String(active?.trades?.length||0);els['history-count'].textContent=String(history.length);
  $('position-count').textContent=String(active?.position?1:0);$('order-count').textContent=String((active?.pending?1:0)+(active?.orderHistory?.length||0));
  for(const [id,mode] of [['positions-tab','positions'],['orders-tab','orders'],['current-tab','current'],['history-tab','history']])$(id).classList.toggle('selected',journalMode===mode);
  if(journalMode==='positions'){
    const p=active?.position;if(!p){const empty=document.createElement('div');empty.className='empty-journal';empty.textContent='当前没有持仓。已提交的限价订单会显示在“订单”中。';els['journal-content'].append(empty);}else{const box=document.createElement('div');box.className='table-wrap';const row=document.createElement('div');row.className='order-row';const text=document.createElement('span');text.textContent=`${active.symbol.replace('USDT','')} ${p.side===1?'买入 / 做多':'卖出 / 做空'} · ${leverageMarginText(p)} · 入场 ${pretty(p.entry)} · 止损 ${protectionText(p.stop)} · 止盈 ${protectionText(p.take)}${Number.isFinite(recordLiquidation(p))?` · 预估强平 ${liquidationText(p)}`:''}`;const close=document.createElement('button');close.textContent='主动平仓';close.addEventListener('click',()=>requestExitReason({returnFocus:close}));const supplement=document.createElement('button');supplement.className='quiet';supplement.textContent='追加计划';supplement.addEventListener('click',()=>requestPlanSupplement({returnFocus:supplement}));const versions=document.createElement('button');versions.className='quiet';versions.textContent='计划版本';versions.addEventListener('click',()=>showPlanHistory(active,p));row.append(text,close,supplement,versions);const reason=document.createElement('p');reason.className='entry-reason-view';reason.textContent=`入场理由：${entryReasonText(p.entryReason)}`;box.append(row,reason);els['journal-content'].append(box);}els.notes.disabled=!active;els.notes.value=active?.notes||'';return;
  }
  if(journalMode==='orders'){
    const orders=[...(active?.orderHistory||[])].reverse();if(active?.pending)orders.unshift({...active.pending,status:'pending'});
    if(!orders.length){const empty=document.createElement('div');empty.className='empty-journal';empty.textContent='本轮还没有待成交或已处理订单。';els['journal-content'].append(empty);}
    else{const list=document.createElement('div');list.className='history-list';for(const order of orders){const row=document.createElement('div');row.className='history-card';const title=document.createElement('strong');title.textContent=`${order.side===1?'买入 / 做多':'卖出 / 做空'} · ${order.type==='limit'?'限价':'市价'} · ${order.status==='pending'?'等待触价':order.status==='filled'?'已成交':'已撤销'}`;const detail=document.createElement('span');detail.textContent=`入场 ${pretty(order.entryPrice)} · 止损 ${protectionText(order.stop)} · 止盈 ${protectionText(order.take)} · ${pretty(order.notional)} U · ${leverageMarginText(order)}${Number.isFinite(recordLiquidation(order))?` · 预估强平 ${liquidationText(order)}`:''}`;const entryReason=document.createElement('span');entryReason.className='entry-reason-view';entryReason.textContent=`入场理由：${entryReasonText(order.entryReason)}`;row.append(title,detail,entryReason);if(order.reason){const outcome=document.createElement('span');outcome.textContent=`处理原因：${order.reason}`;row.append(outcome);}if(order.status==='pending'){const cancel=document.createElement('button');cancel.textContent='撤销';cancel.addEventListener('click',()=>{const before=reviewStateProjection(active);clearModificationDraft();const cancelled=cancelOrder(active,'用户撤单',currentData());render();persist({kind:'order-cancelled',before,orderId:cancelled?.id,planId:cancelled?.planId,actor:'user',reason:'用户撤单'});if(cancelled)toast(`限价单已撤销 · ${active.symbol.replace('USDT','')} ${cancelled.side===1?'做多':'做空'} · ${pretty(cancelled.entryPrice)}`);});row.append(cancel);}list.append(row);}els['journal-content'].append(list);}els.notes.disabled=true;els.notes.value='';return;
  }
  if(journalMode==='current'){
    renderTradeTable(active?.trades||[],active?.symbol||'BTCUSDT',active);
    els.notes.disabled=!active;els.notes.value=active?.notes||'';return;
  }
  els.notes.disabled=true;els.notes.value='';
  if(!history.length){const empty=document.createElement('div');empty.className='empty-journal';empty.textContent='完成一轮后，练习会保存在这里。';els['journal-content'].append(empty);return;}
  const list=document.createElement('div');list.className='history-list';
  for(const item of [...history].reverse()){
    const s=item.session,button=document.createElement('button');button.type='button';button.className='history-card'+(selectedHistoryId===item.id?' active':'');
    const title=document.createElement('strong');const left=document.createElement('span');left.textContent=`${s.symbol.replace('USDT','')} · ${TF_LABELS.get(s.tf)||s.tf+'秒'}`;const result=document.createElement('span');const m=item.metrics||{pnl:0};result.textContent=`${m.pnl>=0?'+':''}${pretty(m.pnl)} U`;result.className=m.pnl>=0?'positive':'negative';title.append(left,result);
    const meta=document.createElement('span');meta.textContent=`${showTime(Date.parse(s.created)/1000,false)} · ${(s.trades||[]).length} 笔已平仓`;
    const note=document.createElement('small');note.textContent=s.notes?`笔记：${s.notes.slice(0,80)}`:'无练习笔记';button.append(title,meta,note);button.addEventListener('click',()=>{selectedHistoryId=item.id;renderJournal();});list.append(button);
  }
  els['journal-content'].append(list);
  const selected=history.find(x=>x.id===selectedHistoryId);
  if(selected)renderTradeTable(selected.session.trades||[],selected.session.symbol,selected.session);
}
function renderModificationPanel(container=els.position,createIfMissing=true){
  const oldPanel=container.querySelector('.modification-confirmation');if(!oldPanel&&!createIfMissing)return;
  container.querySelector('.modification-confirmation')?.remove();
  if(!modificationDraft||!modificationIsCurrent()){if(modificationDraft)modificationDraft=null;return;}
  const preview=dragDraft||modificationDraft,base=modificationDraft._edit.base,changed=modificationChanged(preview),panel=document.createElement('section');panel.className='modification-confirmation';
  const title=document.createElement('strong');title.textContent='待确认修改';panel.append(title);
  const actual=document.createElement('p');actual.className='modification-values';actual.textContent=`实际：入场 ${pretty(base.entryPrice)} · 止损 ${protectionText(base.stop)} · 止盈 ${protectionText(base.take)}`;
  const next=document.createElement('p');next.className='modification-values preview';next.textContent=`预览：入场 ${pretty(preview.entryPrice??preview.entry)} · 止损 ${protectionText(preview.stop)} · 止盈 ${protectionText(preview.take)}`;panel.append(actual,next);
  const reasonLabel=document.createElement('label');reasonLabel.className='modification-reason-label';reasonLabel.textContent='修改理由（可选）';const reasonInput=document.createElement('textarea');reasonInput.className='modification-reason';reasonInput.maxLength=2000;reasonInput.rows=2;reasonInput.placeholder='例如：结构变化，调整风险';reasonInput.value=modificationDraft.changeReason||'';reasonInput.addEventListener('input',()=>{modificationDraft.changeReason=reasonInput.value;});reasonLabel.append(reasonInput);panel.append(reasonLabel);
  const actions=document.createElement('div');actions.className='modification-actions';const confirm=document.createElement('button');confirm.type='button';confirm.className='primary';confirm.textContent='确认修改';confirm.disabled=!changed||!!dragState||!modificationIsCurrent(preview);confirm.addEventListener('click',confirmModification);
  const cancel=document.createElement('button');cancel.type='button';cancel.className='quiet';cancel.textContent='取消';cancel.disabled=!!dragState;cancel.addEventListener('click',cancelModification);actions.append(confirm,cancel);panel.append(actions);container.append(panel);
}
function cancelModification(){
  if(!modificationDraft)return;
  clearModificationDraft();chart.priceScale('right').applyOptions({autoScale:true});render();
}
function confirmModification(){
  if(!modificationDraft||dragState)return;
  const draft=modificationDraft;
  if(!modificationIsCurrent(draft)){clearModificationDraft();render();toast('订单状态已变化，修改预览已取消');return;}
  if(!modificationChanged(draft)){cancelModification();return;}
  const target=managedTarget(),base=draft._edit.base,changes=modifiedParts(base,draft),side=draft.side,kind=draft._edit.kind,rawChangeReason=typeof draft.changeReason==='string'&&draft.changeReason.trim()?draft.changeReason:null;
  try{
    const before=reviewStateProjection(active),orderId=target?.order?.id||target?.order?.orderId||null,tradeId=target?.order?.tradeId||null,planId=target?.order?.planId||null;
    const beforeValues={entryPrice:target.order.entryPrice??target.order.entry,stop:target.order.stop??null,take:target.order.take??null,notional:target.order.notional??null,leverage:target.order.leverage??null,margin:target.order.margin??null};
    const riskCount=Array.isArray(active.riskChanges)?active.riskChanges.length:0,metadata={planId,reason:rawChangeReason,rawReason:rawChangeReason,modelConfigId:reviewModelConfigId(active)};
    let result=null;
    if(kind==='pending')result=updatePendingOrder(active,currentData(),draft.entryPrice??draft.entry,draft.stop,draft.take,metadata);
    else result=updateProtection(active,currentData(),draft.stop,draft.take,metadata);
    const updatedTarget=managedTarget()?.order||result?.order||active.position||null;
    const afterValues={entryPrice:updatedTarget?.entryPrice??updatedTarget?.entry,stop:updatedTarget?.stop??null,take:updatedTarget?.take??null,notional:updatedTarget?.notional??null,leverage:updatedTarget?.leverage??null,margin:updatedTarget?.margin??null};
    const mod=modificationEvidence({before:beforeValues,after:afterValues,reason:rawChangeReason,replayMarketTime:replayClock(),visibleThrough:replayClock(),riskChanges:Array.isArray(active.riskChanges)?active.riskChanges.slice(riskCount):[]});
    const modification={...mod,changes,result:clone(result||null)};
    clearModificationDraft();chart.priceScale('right').applyOptions({autoScale:true});render();persist({kind:kind==='pending'?'order-modified':'protection-changed',before,orderId,tradeId,planId,snapshotId:reviewId('snapshot'),actor:'user',timingClass:active.position?'position':'pre-trade',reason:rawChangeReason,modification,capture:true,after:{...reviewStateProjection(active),modification}});
    const coin=active.symbol.replace('USDT',''),direction=side===1?'做多':'做空';
    if(result?.status==='filled')toast(`限价改单成交 · ${coin} ${direction} · ${pretty(result.position?.entry??result.order?.fillPrice)}`);
    else if(kind==='pending')toast(`限价单已修改 · ${coin} ${direction} · ${pretty(result?.order?.entryPrice??draft.entryPrice)} · ${changes.join('，')||'订单参数'}`);
    else toast(`保护价已修改 · ${coin} ${direction} · ${changes.join('，')}`);
  }catch(error){toast(error.message||'修改未生效，请调整后重试');renderModificationPanel(els.position);}
}
function renderPosition(){
  if(modificationDraft&&!modificationIsCurrent())modificationDraft=null;
  if(modificationDraft&&dragState&&modificationIsCurrent())return;
  const p=active?.position,pending=active?.pending;
  els.position.replaceChildren();
  if(!p&&!pending){els.position.className='position-empty';const plus=document.createElement('span');plus.className='empty-cross';plus.textContent='＋';const line=document.createElement('p');line.textContent='等待你的判断';const hint=document.createElement('span');hint.textContent='市价单立即成交；限价按指定价或更优成交，否则挂起等待';els.position.append(plus,line,hint);els['position-badge'].textContent='空仓';return;}
  if(pending){
    els.position.className='position-pending';els['position-badge'].textContent='限价待成交';els['position-badge'].className='';
    const top=document.createElement('div');top.className='pos-top';const side=document.createElement('span');side.textContent=`${active.symbol.replace('USDT','')} ${pending.side===1?'买入 / 做多':'卖出 / 做空'}`;const amount=document.createElement('span');amount.textContent=`${pretty(pending.notional)} U 名义`;top.append(side,amount);
    const pendingRows=[['杠杆 / 保证金',leverageMarginText(pending)],['限价',pretty(pending.entryPrice)],['开仓手续费',`${pretty(pending.notional*FEE)} U`],['止损价',protectionText(pending.stop)],['止盈价',protectionText(pending.take)]];if(Number.isFinite(recordLiquidation(pending)))pendingRows.push(['预估强平价',liquidationText(pending)]);
    const dl=document.createElement('dl');for(const [label,value] of pendingRows){const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;dl.append(dt,dd);}const entryReason=document.createElement('p');entryReason.className='entry-reason-view';entryReason.textContent=`入场理由：${entryReasonText(pending.entryReason)}`;
    const locate=document.createElement('button');locate.className='cancel-pending';locate.textContent='定位订单线';locate.addEventListener('click',locatePlanPrices);
    const cancel=document.createElement('button');cancel.className='cancel-pending';cancel.textContent='撤销限价单';cancel.addEventListener('click',()=>{const before=reviewStateProjection(active);clearModificationDraft();const cancelled=cancelOrder(active,'用户撤单',currentData());chart.priceScale('right').applyOptions({autoScale:true});render();persist({kind:'order-cancelled',before,orderId:cancelled?.id,planId:cancelled?.planId,actor:'user',reason:'用户撤单'});toast('限价单已撤销');});els.position.append(top,dl,entryReason,locate,cancel);renderModificationPanel(els.position);return;
  }
  els.position.className='position-live';els['position-badge'].textContent=p.side===1?'做多持仓':'做空持仓';els['position-badge'].className=p.side===1?'positive':'negative';
  const top=document.createElement('div');top.className='pos-top';const side=document.createElement('span');side.textContent=`${active.symbol.replace('USDT','')} ${p.side===1?'买入 / 做多':'卖出 / 做空'}`;const amount=document.createElement('span');amount.textContent=`${pretty(p.notional)} U 名义`;top.append(side,amount);
  const positionRows=[['杠杆 / 保证金',leverageMarginText(p)],['开仓手续费',`${pretty(p.entryFee??p.notional*FEE)} U`],['入场价',pretty(p.entry)],['止损价',protectionText(p.stop)],['止盈价',protectionText(p.take)],['数量',pretty(p.qty,6)]];if(Number.isFinite(recordLiquidation(p)))positionRows.push(['预估强平价',liquidationText(p)]);
  const dl=document.createElement('dl');for(const [label,value] of positionRows){const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;dl.append(dt,dd);}const entryReason=document.createElement('p');entryReason.className='entry-reason-view';entryReason.textContent=`入场理由：${entryReasonText(p.entryReason)}`;
  const locate=document.createElement('button');locate.className='cancel-pending';locate.textContent='定位持仓线';locate.addEventListener('click',locatePlanPrices);
  const close=document.createElement('button');close.type='button';close.className='close-position';close.textContent='主动平仓';close.addEventListener('click',()=>requestExitReason({returnFocus:close}));
  els.position.append(top,dl,entryReason,locate,close);renderModificationPanel(els.position);
}
function render(resetRange=false,updateChart=true){
  if(!active)return;
  const data=currentData(),m=metrics(active,data);if(Number.isFinite(active.speed))els.speed.value=String(active.speed);else active.speed=Number(els.speed.value)||1500;
  els.equity.textContent=pretty(m.equity);els.pnl.replaceChildren();const pnlText=document.createTextNode(pretty(m.pnl));const pct=document.createElement('em');pct.textContent=`${m.pnl>=0?'+':''}${pretty(m.pnl/INITIAL*100)}%`;els.pnl.append(pnlText,pct);els.pnl.className=m.pnl>=0?'positive':'negative';
  els.unreal.textContent=pretty(m.unreal);els.unreal.className=m.unreal>=0?'positive':'negative';els['trade-count'].textContent=`${active.trades.length} 笔成交`;els['win-rate'].textContent=m.winRate===null?'—':`${pretty(m.winRate,1)}%`;
  els.balance.textContent=`${pretty(active.balance)} USDT`;els['coin-mark'].textContent=active.symbol.startsWith('BTC')?'₿':'◆';els.symbol.value=active.symbol;els['session-badge'].textContent=`${active.symbol.replace('USDT','')} · ${TF_LABELS.get(active.tf)} · ${active.position?'持仓中':active.pending?'限价待成交':'盲回放'}`;
  document.querySelectorAll('[data-tf]').forEach(button=>button.classList.toggle('active',Number(button.dataset.tf)===active.tf));
  active.volume=active.volume!==false;els.blind.checked=!!active.blind;els.ma.checked=!!active.ma;els.ma10.checked=!!active.ma10;els.volume.checked=active.volume;
  syncReplayProgress(data);
  const hasOrder=!!active.position||!!active.pending,ended=replayIsEnded(active,data),reasonOpen=!!pendingOrderRequest,reasonLocked=reasonBlocksReplay();els.play.disabled=ended||reasonLocked||fastForwarding||minuteActionPending&&!isPlaying;els['step-minute'].disabled=ended||reasonLocked||minuteActionPending||fastForwarding;els.step.disabled=ended||reasonLocked||minuteActionPending||fastForwarding;els['cancel-advance'].hidden=!fastForwarding;els['retry-minute'].hidden=!minuteRetryAction;els.long.disabled=ended||hasOrder||reasonOpen;els.short.disabled=ended||hasOrder||reasonOpen;els['size-range'].disabled=hasOrder||reasonOpen;els['leverage-range'].disabled=hasOrder||reasonOpen;syncDirectionSelection();
  els.play.textContent=isPlaying?'Ⅱ':'▶';els.play.setAttribute('aria-label',isPlaying?'暂停回放':'自动播放');els['replay-status'].textContent=ended?'本轮结束':fastForwarding?'快进中':active.position?'持仓中':active.pending?'限价待成交':'盲回放';
  els['new-session'].disabled=reasonOpen;els.symbol.disabled=reasonOpen;els['order-hint'].textContent=modificationDraft?'图上线位修改仅为预览；在右侧确认修改后生效，取消可恢复':active.position?'持仓期间不能重复下单':active.pending?'限价单等待后续行情满足价格条件':'市价立即成交；限价按指定价或更优成交，否则挂起等待';
  const sizePct=Number.isFinite(active.sizePercent)?active.sizePercent:10;els['size-range'].value=String(sizePct);syncSize(sizePct,false);syncLeverage(false);
  $('market-type').classList.toggle('active',selectedOrderType==='market');$('limit-type').classList.toggle('active',selectedOrderType==='limit');$('market-type').disabled=hasOrder||reasonOpen;$('limit-type').disabled=hasOrder||reasonOpen;document.querySelectorAll('[data-size]').forEach(button=>button.disabled=hasOrder||reasonOpen);els['confirm-plan'].disabled=reasonOpen||els['confirm-plan'].disabled;els['cancel-plan'].disabled=reasonOpen;syncPlanSummary();
  if(reasonOpen){els['reason-confirm'].disabled=reasonSubmitting||!els['entry-reason'].value.trim();}
  const bars=disclosedBars();if(updateChart)renderChart(false,resetRange);else renderPlanOverlay();updateQuote(bars.at(-1));renderPosition();renderJournal();
}
function syncReplayProgress(data=currentData()){
  if(!active)return;
  const start=active.startTime??((data[active.start]?.[0]??0)+BASE),end=(data[active.end]?.[0]??0)+BASE,now=replayClock(active,data)??start;
  const span=Math.max(1,end-start),elapsed=Math.max(0,now-start),pct=Math.max(0,Math.min(100,elapsed/span*100));
  els['progress-bar'].style.width=`${pct}%`;
  const days=Math.min(180,Math.floor(elapsed/86400)),tfMinutes=active.tf/60,periodStart=intervalStart(now,active.tf),formed=Math.max(0,Math.min(tfMinutes,Math.floor((now-periodStart)/60)));
  els['progress-text'].textContent=`已回放 ${days} / 180 天 · ${showTime(now)} · ${formed===0?'下一根K线待开始':`当前K线 ${formed}/${tfMinutes}分`}`;
}
function syncPlaybackControls(){
  if(!active)return;
  const ended=replayIsEnded(),locked=reasonBlocksReplay()||transitionPending;
  els.play.disabled=ended||locked||fastForwarding||minuteActionPending&&!isPlaying;
  els['step-minute'].disabled=ended||locked||minuteActionPending||fastForwarding;
  els.step.disabled=ended||locked||minuteActionPending||fastForwarding;
  els['cancel-advance'].hidden=!fastForwarding;els['retry-minute'].hidden=!minuteRetryAction;
}
function invalidateMinuteWork(){
  minuteGeneration++;minuteRequestId++;minuteActionPending=false;fastForwarding=false;clearTimeout(playTimer);playTimer=0;isPlaying=false;
}
function pause(renderAfter=true){const interruptedFastForward=fastForwarding;invalidateMinuteWork();if(renderAfter&&active&&!invalidSavedActive)render();else if(active&&!invalidSavedActive)syncPlaybackControls();if(interruptedFastForward&&active)persist();}
function minuteResultMessage(result,session=active){
  const messages=[];
  const coin=session?.symbol?.replace(/USDT$/,'')||session?.symbol||'订单';
  const direction=side=>side===1?'做多':'做空';
  if(result.orderFilled)messages.push(`限价单已成交 · ${coin} ${direction(result.orderFilled.side)} · 成交 ${pretty(result.orderFilled.fillPrice)}`);
  if(result.orderCancelled)messages.push(`限价单已结束 · ${coin} ${direction(result.orderCancelled.side)} · ${result.orderCancelled.reason||'本轮结束'}`);
  if(result.trade)messages.push(`${result.trade.reason} · ${coin} ${direction(result.trade.side)} · 平仓 ${pretty(result.trade.exit)} · 盈亏 ${pretty(result.trade.pnl)} USDT`);
  if(result.ended)messages.push('本轮行情已走完');
  return messages;
}
async function advanceOneMinuteCore(generation,{draw=true,announce=true}={}){
  if(minuteActionPending||!active||reasonBlocksReplay()||transitionPending||replayIsEnded())return null;
  const session=active,data=currentData(),beforeTime=replayClock(session,data),beforeCursor=session.cursor,wasFastForwarding=fastForwarding;
  if(!Number.isFinite(beforeTime))return null;
  const requestId=++minuteRequestId;minuteActionPending=true;minuteRetryAction=null;
  els['progress-text'].textContent='正在读取下一根真实分钟行情…';syncPlaybackControls();
  try{
    const candle=await nextMinute(session.symbol,beforeTime-60);
    if(requestId!==minuteRequestId||generation!==minuteGeneration||active!==session||session.cursor!==beforeCursor||replayClock(session,data)!==beforeTime||reasonBlocksReplay())return null;
    const stateBefore=reviewStateProjection(session);
    const result=advanceMinute(session,candle,data);
    void reviewRecorder.appendMinute(session,candle).catch(error=>setReviewStatus(`分钟过程记录未完整保存：${error?.message||'本地存储不可用'}`,true));
    syncDraftsAfterMinute();
    const messages=minuteResultMessage(result,session),stop=!!result.ended;
    if(stop)invalidateMinuteWork();
    const semantic=[],stages=Array.isArray(result.executionEvents)?result.executionEvents:[];
    if(!stages.length&&result.orderFilled)semantic.push(['order-filled',{orderFilled:clone(result.orderFilled),orderId:result.orderFilled.id}]);
    if(result.orderCancelled&&!stages.some(item=>item.kind==='order-cancelled'))semantic.push(['order-cancelled',{orderCancelled:clone(result.orderCancelled),orderId:result.orderCancelled.id}]);
    if(!stages.length&&result.trade)semantic.push(['position-auto-closed',{trade:clone(result.trade),tradeId:result.trade.id||result.trade.orderId,orderId:result.trade.orderId}]);
    if(result.ended)semantic.push(['round-ended',{ended:true}]);
    if(draw||stop||semantic.length||stages.length){render();persist({audit:false});}
    else syncReplayProgress(data);
    let eventBefore=stateBefore;
    const progressedState=reviewStateProjection(session);
    for(const stage of stages){
      // A minute is one atomic market disclosure. Execution stages happen
      // against its close, so use the post-advance clock while retaining only
      // the engine's stage-specific position/order/trade and account fields.
      // Never spread the final session projection here: a fill followed by an
      // exit in the same minute must not make the fill snapshot look closed.
      const snapshots=executionStageSnapshots(stateBefore,progressedState,stage);
      const stageBefore=snapshots.before,stageAfter={...snapshots.after,event:{executionEvent:clone(stage)}};
      const eventSnapshotId=reviewId('snapshot'),stagePlanId=stage.position?.planId||stage.after?.position?.planId||stage.before?.position?.planId||null;
      recordReviewEvent(stage.kind,{session,before:stageBefore,after:stageAfter,orderId:stage.orderId,tradeId:stage.tradeId,planId:stagePlanId,snapshotId:eventSnapshotId,actor:'engine',recordedAt:stage.recordedAt,reason:stage.reason,references:{executionStage:stage.seq,fillId:stage.fillId||null,positionId:stage.positionId||null,marketTime:stage.marketTime??stage.replayMarketTime??null},view:{...reviewView(session),visibleThrough:stage.visibleThrough??stage.replayMarketTime??reviewView(session).visibleThrough,marketTime:stage.marketTime??stage.replayMarketTime??null,executionStage:stage.seq,minuteFinalCanvas:true,fastForwarding:wasFastForwarding,intrabarActualUnknown:stage.intrabarActualUnknown!==false},captureType:'same-minute-final-chart-with-engine-stage-overlay',screenshot:keyReviewKind(stage.kind)});
      eventBefore=stageAfter;
    }
    for(const [kind,detail] of semantic){
      const stateAfter=reviewStateProjection(session);
      recordReviewEvent(kind,{session,before:eventBefore,after:{...stateAfter,event:detail},orderId:detail.orderId,tradeId:detail.tradeId,planId:detail.orderFilled?.planId||detail.orderCancelled?.planId||detail.trade?.planId||null,snapshotId:reviewId('snapshot'),actor:kind==='round-ended'?'engine':'engine',reason:detail.trade?.reason||detail.orderCancelled?.reason, screenshot:keyReviewKind(kind),view:{...reviewView(session),fastForwarding:wasFastForwarding}});
      eventBefore=stateAfter;
    }
    if(!semantic.length&&(draw||stop))void reviewRecorder.observe(session,{view:reviewView(session)}).catch(error=>setReviewStatus(`过程记录未完整保存：${error?.message||'本地存储不可用'}`,true));
    if((announce||result.ended)&&messages.length)toast(messages.join(' · '));
    return {...result,stop,messages};
  }catch(error){
    if(requestId!==minuteRequestId||generation!==minuteGeneration||active!==session)return null;
    const failedAction=fastForwarding?'boundary':'minute';
    invalidateMinuteWork();minuteRetryAction=failedAction;
    render();persist();els['progress-text'].textContent='分钟行情读取失败，当前进度已保留';els['retry-minute'].hidden=false;toast(error?.message||'分钟行情读取失败，点击重试');
    return {failed:true,stop:true};
  }finally{
    if(requestId===minuteRequestId){minuteActionPending=false;syncPlaybackControls();}
  }
}
function keyReviewKind(kind){return /^(order-|position-|protection-|drawing-)/.test(kind);}
async function runAutomaticMinute(generation){
  const result=await advanceOneMinuteCore(generation,{draw:true});
  if(result?.failed||result?.stop||generation!==minuteGeneration||!isPlaying||reasonBlocksReplay())return;
  playTimer=setTimeout(()=>runAutomaticMinute(generation),Number(els.speed.value));
}
function advanceOneMinute(){
  if(minuteActionPending||fastForwarding||reasonBlocksReplay()||transitionPending||!active)return;
  minuteRetryAction=null;return advanceOneMinuteCore(minuteGeneration,{draw:true,action:'minute'});
}
async function advanceToTfBoundary(){
  if(minuteActionPending||fastForwarding||reasonBlocksReplay()||transitionPending||!active||replayIsEnded())return;
  const generation=minuteGeneration,session=active,startTime=replayClock(),target=intervalStart(startTime,active.tf)+active.tf;
  fastForwarding=true;minuteRetryAction=null;syncPlaybackControls();
  let steps=0,failed=false;const eventMessages=[];
  try{
    while(generation===minuteGeneration&&active===session&&!reasonBlocksReplay()&&!transitionPending&&!replayIsEnded()){
      if(replayClock()>=target)break;
      const result=await advanceOneMinuteCore(generation,{draw:false,announce:false});
      if(!result||result.failed||result.stop){failed=!!result?.failed;eventMessages.push(...(result?.messages||[]));break;}
      eventMessages.push(...(result.messages||[]));
      steps++;
      if(steps%15===0){render();persist();await new Promise(resolve=>setTimeout(resolve,0));}
    }
  }finally{
    if(generation===minuteGeneration&&active===session){fastForwarding=false;render();persist();if(!failed&&steps){
      if(eventMessages.length)toast(eventMessages.join(' · '));
      else toast(`已快进 ${steps} 分钟`);
    }}
  }
  return {steps,failed};
}
function togglePlay(){
  if(pendingOrderRequest||transitionPending||fastForwarding)return;
  if(isPlaying){pause();return;}
  if(!active||replayIsEnded()||minuteActionPending)return;
  minuteRetryAction=null;isPlaying=true;const generation=minuteGeneration;render();playTimer=setTimeout(()=>runAutomaticMinute(generation),Number(els.speed.value));
}
function archiveActive(){
  if(!active)return;
  if(active.pending){const before=reviewStateProjection(active),cancelled=cancelOrder(active,'新一轮开始，未成交挂单撤销',currentData());recordReviewEvent('order-cancelled',{before,after:{...reviewStateProjection(active),cancelled:clone(cancelled)},orderId:cancelled?.id,planId:cancelled?.planId,actor:'user',reason:'新一轮开始，未成交挂单撤销'});}
  if(active.position)throw new Error('请先填写平仓理由并完成主动平仓');
  recordReviewEvent('round-archived',{session:active,before:reviewStateProjection(active),after:{...reviewStateProjection(active),archived:true}});
  let result=null;try{if(!invalidSavedActive)result=metrics(active,currentData());}catch{}
  active.draftPlan=null;uiPlan=null;
  const item={id:active.id,session:clone(active),metrics:result,archivedAt:new Date().toISOString()};history.push(item);invalidSavedActive=false;
}
async function startRound(symbol=active?.symbol||els.symbol.value){
  if(pendingOrderRequest||transitionPending)return false;
  if(active?.position){requestExitReason({archiveSymbol:symbol,returnFocus:els['new-session']});return false;}
  const resumeAfterTransition=!!isPlaying;
  transitionPending=true;
  els['new-session'].disabled=true;els.play.disabled=true;els.step.disabled=true;els['step-minute'].disabled=true;els.long.disabled=true;els.short.disabled=true;els.symbol.disabled=true;
  try{
    pause();
    const data=await loadSymbol(symbol);
    const candidate=createSession(symbol,data);
    clearModificationDraft();archiveActive();candidate.startTime=data[candidate.start][0]+BASE;candidate.sizePercent=10;candidate.leverage=1;candidate.speed=Number(els.speed.value)||1500;candidate.ma10=false;candidate.volume=true;candidate.reviewPlans??=[];active=candidate;drawingAuditSnapshot=clone(active.drawings||[]);selectedOrderType='market';pendingSymbol=null;journalMode='positions';selectedHistoryId=null;els.symbol.value=symbol;hideLoading();render(true);persist({kind:'session-created'});return true;
  }catch(error){
    toast(`新一轮暂未开始：${error.message}。现有练习和往期记录已保留。`);els.symbol.value=active?.symbol||'BTCUSDT';if(invalidSavedActive)showSavedRecordRecovery(error.message);else{hideLoading();if(active)render();}return false;
  }finally{transitionPending=false;els.symbol.disabled=false;if(active&&!invalidSavedActive)els['new-session'].disabled=false;else if(!active)els['new-session'].disabled=false;drawingTools?.refresh();syncDrawingControls();if(resumeAfterTransition&&active&&!replayIsEnded()&&!invalidSavedActive&&!isPlaying)togglePlayWithAudit();syncPlaybackControls();}
}
function maybeStart(symbol){if(pendingOrderRequest)return;pendingSymbol=symbol;if(active?.position){requestExitReason({archiveSymbol:symbol,returnFocus:els['new-session']});return;}if(active?.pending){$('new-dialog').showModal();return;}startRound(symbol);}
function downloadExport(){
  const payload={version:1,source:{marketData:'Binance 现货公开档案',symbols:['BTCUSDT','ETHUSDT'],interval:BASE,replayInterval:60,replayMode:'真实1分钟OHLC逐步回放；所选周期K线由已披露行情聚合',simulation:'本地练习记录，不代表真实成交',leverageModel:'1x–100x逐仓模拟；新订单记录含leverage、margin、marginMode、liquidationPrice；旧记录缺失时按1x显示且不追溯估算强平价',maintenanceMarginRate:0.005},exportedAt:new Date().toISOString(),current:active?clone(active):null,history:clone(history)};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`K线回放_记录_${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url);toast('练习记录 JSON 已导出');
}
function importedSessionMetrics(session){
  const trades=Array.isArray(session?.trades)?session.trades:[],pnl=trades.reduce((sum,trade)=>sum+(Number.isFinite(trade?.pnl)?trade.pnl:0),0);
  return {pnl,trades:trades.length,wins:trades.filter(trade=>trade.pnl>0).length,losses:trades.filter(trade=>trade.pnl<0).length,imported:true};
}
function importedHistorySession(session,replayFrom=null){
  const copy=clone(session);for(const key of ['ledger','fills','accountSnapshots','riskChanges','minuteRows','contextCandles','marketData'])delete copy[key];
  const displayReplayFrom=Number.isFinite(replayFrom)?replayFrom:(Number.isFinite(copy.startTime)?copy.startTime:null);if(Number.isFinite(displayReplayFrom))copy.displayReplayFrom=displayReplayFrom;return copy;
}
async function importReviewFile(file){
  if(!file||reviewImporting)return;
  reviewImporting=true;els['review-import'].disabled=true;setReviewStatus('正在校验复盘文件…');
  try{
    const parsed=await parseReviewImport(file),results=[];
    for(const archive of parsed.archives||[]){
      archive.executionDisabled=true;
      const contentHash=archive.contentHash||parsed.contentHash||null;
      const result=await reviewRecorder.importSessionArchive(archive,{contentHash});results.push(result);
      if(result.status==='imported'||result.status==='duplicate'){
        const id=String(archive.session.id);
        if(!history.some(item=>String(item.id)===id))history.push({id,session:{...importedHistorySession(archive.session,archive.coverage?.replayFrom),importedArchive:true},metrics:importedSessionMetrics(archive.session),archivedAt:new Date().toISOString(),imported:true,importContentHash:contentHash});
      }
    }
    persist({audit:false});renderJournal();
    const imported=results.filter(item=>item.status==='imported').length,duplicates=results.filter(item=>item.status==='duplicate').length,conflicts=results.filter(item=>item.status==='conflict').length;
    const summary=`导入 ${imported} 轮，已存在 ${duplicates} 轮，冲突 ${conflicts} 轮。导入内容仅作为往期资料，不会恢复或推进行情。`;
    setReviewStatus(parsed.issues?.length?`${summary} ${parsed.issues.join('；')}`:summary,!!parsed.issues?.length||!!conflicts);
    toast(conflicts?`导入完成，${conflicts} 轮ID冲突未覆盖现有资料`:`已导入 ${imported} 轮复盘资料`);
  }catch(error){setReviewStatus(`导入未完成：${error?.message||'文件校验失败'}；现有练习未覆盖。`,true);toast('复盘资料导入失败，请查看页面提示');}
  finally{reviewImporting=false;els['review-import'].disabled=false;els['review-import-file'].value='';}
}
async function downloadReviewPackage(){
  if(reviewExporting)return;
  reviewExporting=true;els['review-export'].disabled=true;
  const snapshotAt=Date.now(),currentSnapshot=active?clone(active):null,historySnapshot=clone(history),sessions=[currentSnapshot,...historySnapshot.map(item=>item?.session)].filter(item=>item?.id),sessionIds=sessions.map(item=>String(item.id));
  const cutoffAtClick=new Map(sessions.map(session=>[String(session.id),Number.isFinite(session.minuteCursorTime)?session.minuteCursorTime+60:(datasets.get(session.symbol)?.[session.cursor]?.[0]??NaN)+BASE]));
  const watermarksPromise=reviewRecorder.captureWatermarks(sessionIds),exportData=new Map();
  setReviewStatus('正在固定练习快照并整理本地过程记录…');
  try{
    let watermarks={};
    try{watermarks=await watermarksPromise;await reviewRecorder.flush();}
    catch(error){setReviewStatus(`部分过程记录暂不可读取，将在复盘包中标明：${error?.message||'本地记录异常'}`,true);}
    const loadDataset=async symbol=>{
      if(exportData.has(symbol))return exportData.get(symbol);
      const response=await fetch(`./data/${encodeURIComponent(symbol)}.json`);if(!response.ok)throw new Error(`${symbol}历史数据读取失败（${response.status}）`);
      const payload=await response.json();exportData.set(symbol,payload);return payload;
    };
    const readAudit=async(id,{sessionSnapshot}={})=>{
      const sessionId=String(sessionSnapshot?.id||id),session=sessions.find(item=>String(item.id)===sessionId)||sessionSnapshot;
      let visibleThrough=cutoffAtClick.get(sessionId);
      if(!Number.isFinite(visibleThrough)&&session){const payload=exportData.get(session.symbol);visibleThrough=Number.isFinite(session.minuteCursorTime)?session.minuteCursorTime+60:(payload?.candles?.[session.cursor]?.[0]??NaN)+BASE;}
      return reviewRecorder.readSession(sessionId,{maxSeq:watermarks[sessionId]??0,visibleThrough:Number.isFinite(visibleThrough)?visibleThrough:Number.MAX_SAFE_INTEGER,snapshotAt});
    };
    setReviewStatus('正在整理行情、操作时间线和关键盘面…');
    const result=await buildReviewExport({current:currentSnapshot,history:historySnapshot,loadDataset,readAudit,onProgress:progress=>{
      if(progress.phase==='minutes')setReviewStatus(`正在整理分钟行情 ${progress.completed||0}/${progress.total||0}…`);
      else if(progress.phase==='record')setReviewStatus(`正在整理练习记录 ${Math.min((progress.completed||0)+1,progress.total||0)}/${progress.total||0}…`);
    },exportSnapshotAt:new Date(snapshotAt).toISOString()});
    if(reviewDownloadUrl)URL.revokeObjectURL(reviewDownloadUrl);
    reviewDownloadUrl=URL.createObjectURL(result.blob);els['review-export-download'].href=reviewDownloadUrl;els['review-export-download'].download=result.filename;els['review-export-download'].hidden=false;
    const missing=(result.issues||[]).length;
    setReviewStatus(missing?`复盘包已生成，发现 ${missing} 项资料缺失或不完整，包内已注明。`:'GPT复盘包已生成，包含已回放行情与过程记录。',!!missing);
    toast('复盘包已生成，请点击“下载复盘包”保存');
  }catch(error){setReviewStatus(`复盘包生成失败：${error?.message||'本地资料读取异常'}`,true);toast('复盘包生成失败，请查看页面提示');}
  finally{reviewExporting=false;els['review-export'].disabled=false;}
}
function wireEvents(){
  els['new-session'].addEventListener('click',()=>maybeStart(active?.symbol||els.symbol.value));
  els['confirm-new'].addEventListener('click',()=>{const targetSymbol=pendingSymbol||active?.symbol||els.symbol.value;$('new-dialog').close();startRound(targetSymbol);});
  $('new-dialog').addEventListener('close',()=>{if(pendingSymbol&&pendingSymbol!==active?.symbol)els.symbol.value=active?.symbol||'BTCUSDT';pendingSymbol=null;});
  els.symbol.addEventListener('change',()=>{maybeStart(els.symbol.value);});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
  document.querySelectorAll('[data-tf]').forEach(button=>button.addEventListener('click',()=>{if(!active||transitionPending)return;active.tf=Number(button.dataset.tf);render(true);persist();}));
  $('drawing-select').addEventListener('click',()=>chooseDrawingTool(null));$('drawing-horizontal').addEventListener('click',()=>chooseDrawingTool('horizontal'));$('drawing-trendline').addEventListener('click',()=>chooseDrawingTool('trendline'));$('drawing-zone').addEventListener('click',()=>chooseDrawingTool('zone'));$('drawing-delete').addEventListener('click',deleteSelectedDrawing);
  $('drawing-color').addEventListener('click',toggleDrawingColorPopover);
  $('drawing-color-popover').querySelectorAll('[data-drawing-color-preset]').forEach(button=>button.addEventListener('click',()=>{
    if(drawingTools?.setSelectedColor(button.dataset.drawingColorPreset)){closeDrawingColorPopover();syncDrawingControls();$('drawing-color').focus();}
  }));
  document.addEventListener('pointerdown',event=>{if(drawingColorPopoverOpen&&!event.target.closest?.('.drawing-color-control'))closeDrawingColorPopover();},true);
  window.addEventListener('keydown',event=>{if(drawingColorPopoverOpen&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeDrawingColorPopover();$('drawing-color').focus();}},true);
  els.ma.addEventListener('change',()=>{if(active){const enabled=els.ma.checked;active.ma=enabled;if(maDataKey!==maSignature()){maSeries.setData(computeMa(disclosedBars()));maDataKey=maSignature();}maSeries.applyOptions({visible:active.ma});render();persist();}});
  els.ma10.addEventListener('change',()=>{if(active){const enabled=els.ma10.checked;active.ma10=enabled;if(ma10DataKey!==maSignature()){ma10Series.setData(computeMa(disclosedBars(),10));ma10DataKey=maSignature();}ma10Series.applyOptions({visible:active.ma10});render();persist();}});
  els.volume.addEventListener('change',()=>{if(active){active.volume=els.volume.checked;volumeSeries.applyOptions({visible:active.volume});render();persist({kind:'view-setting'});}});
  els.blind.addEventListener('change',()=>{if(active){active.blind=els.blind.checked;render();persist();}});
  els.play.addEventListener('click',togglePlayWithAudit);
  els['step-minute'].addEventListener('click',()=>manualStep('step-minute'));
  els.step.addEventListener('click',()=>manualStep('step-boundary'));
  els['cancel-advance'].addEventListener('click',()=>{if(fastForwarding)pauseWithAudit();});
  els['retry-minute'].addEventListener('click',()=>{if(!minuteRetryAction||pendingOrderRequest)return;const action=minuteRetryAction;minuteRetryAction=null;void manualStep(action==='boundary'?'step-boundary':'step-minute');});
  els.speed.addEventListener('change',()=>{if(!active)return;const oldSpeed=Number(active.speed)||1500,before=reviewPlaybackSnapshot(active,isPlaying,oldSpeed),wasPlaying=isPlaying;active.speed=Number(els.speed.value)||1500;if(wasPlaying){pause();togglePlay();}persist({kind:'playback-speed',before,after:reviewPlaybackSnapshot(active,isPlaying,active.speed)});});
  els.recenter.addEventListener('click',()=>chart?.timeScale().scrollToRealTime());
  els.long.addEventListener('click',()=>beginPlan(1));els.short.addEventListener('click',()=>beginPlan(-1));
  els['order-form'].addEventListener('submit',e=>e.preventDefault());
  els.notes.addEventListener('input',()=>{if(active){active.notes=els.notes.value;persist({audit:false});}});
  els.notes.addEventListener('change',()=>{if(active){active.notes=els.notes.value;persist({kind:'note-change'});}});
  for(const [id,mode] of [['positions-tab','positions'],['orders-tab','orders'],['current-tab','current'],['history-tab','history']])$(id).addEventListener('click',()=>{journalMode=mode;renderJournal();});
  document.querySelectorAll('[data-size]').forEach(button=>button.addEventListener('click',()=>syncSize(Number(button.dataset.size))));
  els['size-range'].addEventListener('input',()=>{syncSize(Number(els['size-range'].value),false);persist({audit:false});});
  els['size-range'].addEventListener('change',()=>persist({kind:'order-plan'}));
  els['leverage-range'].addEventListener('input',()=>setLeverage(Number(els['leverage-range'].value),false,false));
  els['leverage-range'].addEventListener('change',()=>persist({kind:'order-plan'}));
  document.querySelectorAll('[data-leverage]').forEach(button=>button.addEventListener('click',()=>setLeverage(Number(button.dataset.leverage))));
  $('market-type').addEventListener('click',()=>chooseOrderType('market'));$('limit-type').addEventListener('click',()=>chooseOrderType('limit'));
  els['confirm-plan'].addEventListener('click',confirmPlan);els['cancel-plan'].addEventListener('click',cancelDraft);els['locate-plan'].addEventListener('click',locatePlanPrices);
  els['entry-reason'].addEventListener('input',()=>{
    const value=els['entry-reason'].value;
    if(uiPlan&&active){uiPlan.entryReason=value;active.draftPlan=clone(uiPlan);persist({audit:false});}
    if(pendingOrderRequest){if(reasonMode==='exit')pendingOrderRequest.exitReason=value;else pendingOrderRequest.entryReason=value;}
    els['entry-reason'].removeAttribute('aria-invalid');els['entry-reason-error'].textContent='';
    els['reason-confirm'].disabled=reasonSubmitting||!value.trim();
  });
  els['thesis-choice'].addEventListener('change',()=>{els['thesis-label-wrap'].hidden=els['thesis-choice'].value!=='__new__';});
  els['observation-status'].addEventListener('change',()=>{if(pendingOrderRequest?.mode==='observation')pendingOrderRequest.status=els['observation-status'].value;});
  els['observation-open'].addEventListener('click',()=>openObservation('judgement'));
  els['loss-budget'].addEventListener('input',()=>{
    els['loss-budget-status'].textContent='';
    if(pendingOrderRequest?.mode==='entry'&&uiPlan&&active){const raw=els['loss-budget'].value.trim();uiPlan.lossBudget=raw===''?null:Number(raw);active.draftPlan=clone(uiPlan);persist({audit:false});}
  });
  els['reason-confirm'].addEventListener('click',submitOrderReason);
  els['reason-cancel'].addEventListener('click',()=>closeOrderReason(true));
  els['reason-close'].addEventListener('click',()=>closeOrderReason(true));
  els['order-reason-drag'].addEventListener('pointerdown',dragReasonWindowStart);
  els['order-reason-drag'].addEventListener('pointermove',dragReasonWindowMove);
  els['order-reason-drag'].addEventListener('pointerup',dragReasonWindowEnd);
  els['order-reason-drag'].addEventListener('pointercancel',dragReasonWindowEnd);
  window.addEventListener('resize',()=>{if(pendingOrderRequest)applyReasonWindowPosition(reasonWindowPosition?.x??window.innerWidth-450,reasonWindowPosition?.y??20,true);});
  els.export.addEventListener('click',downloadExport);els.rules.addEventListener('click',()=>els['info-dialog'].showModal());els['source-details'].addEventListener('click',()=>{$('info-dialog').showModal();$('info-dialog').querySelector('details').open=true;});
  els['review-export'].addEventListener('click',downloadReviewPackage);
  els['review-import'].addEventListener('click',()=>els['review-import-file'].click());
  els['review-import-file'].addEventListener('change',()=>void importReviewFile(els['review-import-file'].files?.[0]));
  document.addEventListener('keydown',e=>{
    if(pendingOrderRequest){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeOrderReason(true);}if(reasonBlocksReplay())return;}
    if(e.target.matches('input,textarea,select')||$('info-dialog').open||$('new-dialog').open)return;
    if(fastForwarding){if(e.key==='Escape'){e.preventDefault();pause();}return;}
    if(e.code==='Space'){e.preventDefault();togglePlayWithAudit();}else if(e.key.toLowerCase()==='n'){e.preventDefault();void manualStep('step-minute');}else if(e.key==='ArrowRight'){e.preventDefault();void manualStep('step-boundary');}
  });
}
async function boot(){
  readSaved();initChart();wireEvents();
  if(active){
    try{const data=await loadSymbol(active.symbol);if(!validateSession(active,active.symbol,data))throw new Error('保存的练习状态校验失败，记录已保留');invalidSavedActive=false;if((!Array.isArray(active.modelConfigs)||!active.modelConfigs.length)&&ensureEvidenceBaseline(active,data))persist({audit:false});active.reviewPlans??=[];await ensureLegacyEvidenceBaselines();if(!active.startTime)active.startTime=data[active.start][0]+BASE;active.ma10=active.ma10===true;active.volume=active.volume!==false;active.speed=Number.isFinite(active.speed)?active.speed:1500;drawingAuditSnapshot=clone(active.drawings||[]);selectedOrderType=active.selectedOrderType||'market';if(active.draftPlan){uiPlan=clone(active.draftPlan);selectedOrderType=uiPlan.orderType||selectedOrderType;els['plan-actions'].hidden=false;}hideLoading();render(true);persist({audit:false});return;}
    catch(error){invalidSavedActive=true;showSavedRecordRecovery(error.message);return;}
  }
  const symbol=active?.symbol||'BTCUSDT';
  try{await loadSymbol(symbol);await ensureLegacyEvidenceBaselines();await startRound(symbol);}
  catch(error){setLoading(`${error.message}。检查网络或数据文件后重试。`,true);els['new-session'].disabled=false;}
}
async function retryRecovery(){
  const symbol=active?.symbol||els.symbol.value;
  try{await loadSymbol(symbol,true);if(active&&!validateSession(active,symbol,datasets.get(symbol)))throw new Error('保存的练习状态校验失败');invalidSavedActive=false;if(active&&!active.startTime)active.startTime=datasets.get(symbol)[active.start][0]+BASE;hideLoading();if(active){render(true);persist();}else await startRound(symbol);}
  catch(error){setLoading(`${error.message}。本地记录仍保留，可再次重试，或导出备份。`,true);}
}
boot();
