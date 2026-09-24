import {createChart, CandlestickSeries, LineSeries, CrosshairMode, ColorType} from './vendor/charts.mjs';
import {INITIAL, FEE, SLIP, BASE, WARMUP, createSession, validateSession, aggregate, openPosition, closePosition, placeOrder, cancelOrder, updatePendingOrder, updateProtection, advance, metrics} from './engine.mjs';

const $ = id => document.getElementById(id);
const els = Object.fromEntries(['save-status','new-session','equity','pnl','unreal','trade-count','win-rate','symbol','coin-mark','ma','blind','recenter','last-price','last-change','ohlc','loading','play','step','speed','replay-status','progress-text','progress-bar','balance','notional','risk-preview','long','short','order-hint','position-badge','position','journal-count','history-count','journal-content','notes','current-tab','history-tab','order-form','toast','new-dialog','confirm-new','info-dialog','export','rules','source-details','source-label','size-range','size-readout','plan-actions','plan-hint','confirm-plan','cancel-plan','locate-plan','session-badge'].map(id=>[id,$(id)]));
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
let toastTimer = 0;
let warnedStorage = false;
let transitionPending = false;
let invalidSavedActive = false;
let currentPayload = null;
let activePriceLines = [];
let maDataKey = null;
let uiPlan = null;
let dragState = null;
let dragDraft = null;
let frozenPlanLevels = null;
let overlayFrame = 0;
let projectionFrame = 0;
let chartOverlay = null;
let selectedOrderType = 'market';
let chart, candleSeries, maSeries, resizeObserver;

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
  if(saved.active&&saved.active.version===1&&typeof saved.active.symbol==='string') active=saved.active;
  return saved;
}
function persist() {
  try { localStorage.setItem(STORE_KEY,JSON.stringify({version:1,source:'Binance spot public archive; UI simulation',active,history})); els['save-status'].textContent='已保存在此浏览器'; warnedStorage=false; return true; }
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
function candleTime(index){const data=datasets.get(active?.symbol);return data?.[index]?.[0]??0;}
function utcDate(epoch){return new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(epoch*1000));}
function relativeTime(epoch,session=active,symbol=session?.symbol){
  const source=datasets.get(symbol);
  const anchor=session?.startTime??(source?.[session?.start]?.[0]??NaN)+BASE;
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
function calcNotional(percent){const balance=active?.balance??INITIAL;return Math.floor((balance/(1+FEE))*(percent/100)*100)/100;}
function syncSize(percent,persistNow=true){
  percent=Math.max(0,Math.min(100,Number(percent)||0));const amount=calcNotional(percent);
  if(active){active.sizePercent=percent;if(uiPlan)uiPlan.notional=amount;}
  els['size-range'].value=String(percent);els['size-readout'].textContent=`${percent.toFixed(1).replace(/\.0$/,'')}% · ${pretty(amount)} USDT`;els.notional.value=String(amount);
  syncPlanSummary();if(persistNow&&active)persist();
}
function beginPlan(side){
  if(!active||active.position||active.pending||transitionPending)return;
  pause(false);els.play.textContent='▶';els.play.setAttribute('aria-label','自动播放');
  const entry=currentData()[active.cursor][4],notional=calcNotional(active.sizePercent??10),previous=uiPlan;
  const stopDistance=previous&&Number.isFinite(previous.stop)?Math.abs(previous.entryPrice-previous.stop)/previous.entryPrice:null;
  const takeDistance=previous&&Number.isFinite(previous.take)?Math.abs(previous.take-previous.entryPrice)/previous.entryPrice:null;
  uiPlan={side,orderType:selectedOrderType,entryPrice:entry,stop:stopDistance===null?null:entry*(1-side*stopDistance),take:takeDistance===null?null:entry*(1+side*takeDistance),notional};
  active.draftPlan=clone(uiPlan);els['plan-actions'].hidden=false;els.play.disabled=true;els.step.disabled=true;chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();renderPosition();syncPlanSummary();syncDirectionSelection();persist();
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
  if(active?.position&&!uiPlan&&!active?.pending)return currentData()[active.cursor]?.[4]??plan.entry;
  return plan.entryPrice??plan.entry;
}
function protectionPreviewValid(kind,price,plan){return validProtection(plan.side,kind,price,protectionAnchor(plan));}
function chooseOrderType(type){
  if(active?.position||active?.pending)return;selectedOrderType=type;if(active)active.selectedOrderType=type;if(uiPlan){const old=uiPlan;uiPlan.orderType=type;if(type==='market'){const price=currentData()[active.cursor][4],delta=price-old.entryPrice;uiPlan.entryPrice=price;if(Number.isFinite(uiPlan.stop))uiPlan.stop+=delta;if(Number.isFinite(uiPlan.take))uiPlan.take+=delta;}active.draftPlan=clone(uiPlan);chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();syncPlanSummary();persist();}
  $('market-type').classList.toggle('active',type==='market');$('limit-type').classList.toggle('active',type==='limit');if(active&&!uiPlan)persist();
}
function confirmPlan(){
  if(!uiPlan||!active||Number(els.notional.value)<=0){toast('请选择大于0%的仓位比例');return;}
  pause(false);
  try{
    const p=uiPlan,result=placeOrder(active,currentData(),p.side,Number(els.notional.value),p.entryPrice,p.stop,p.take,p.orderType);
    uiPlan=null;active.draftPlan=null;els['plan-actions'].hidden=true;chart.priceScale('right').applyOptions({autoScale:true});render();persist();
    if(result.status==='pending')toast('限价单已提交，等待后续行情触价');else toast(p.orderType==='limit'?'限价单已按指定价或更优价格成交':`市价${p.side===1?'买入 / 做多':'卖出 / 做空'}已成交`);
  }catch(error){toast(error.message||'订单未提交');}
}
function cancelDraft(){uiPlan=null;if(active)active.draftPlan=null;els['plan-actions'].hidden=true;chart.priceScale('right').applyOptions({autoScale:true});render();persist();}
function locatePlanPrices(){chart.priceScale('right').applyOptions({autoScale:true});chart.timeScale().scrollToRealTime();renderPlanOverlay();}
function disclosedBars(){
  if(!active)return [];
  return aggregate(currentData(),active.cursor,active.tf,Math.max(0,active.start-Math.ceil(WARMUP/BASE)));
}
function computeMa(bars){let sum=0;return bars.map((bar,i)=>{sum+=bar.close;if(i>=20)sum-=bars[i-20].close;return i>=19?{time:bar.time,value:sum/20}:null;}).filter(Boolean);}
function maSignature(){return active?`${active.id}|${active.symbol}|${active.tf}|${active.cursor}`:'';}
function effectivePlan(){return dragDraft||uiPlan||active?.pending||active?.position||null;}
function getPlanLevels(){if(frozenPlanLevels)return frozenPlanLevels;const p=effectivePlan();return p?[p.entryPrice??p.entry,p.stop,p.take].filter(Number.isFinite):[];}
function syncPlanSummary(){
  const p=effectivePlan(),isDraft=!!uiPlan;
  if(els['plan-actions'])els['plan-actions'].hidden=!isDraft;
  if(!p){els['risk-preview'].textContent='—';return;}
  const entry=p.entryPrice??p.entry,side=p.side;
  const stopOn=Number.isFinite(p.stop),takeOn=Number.isFinite(p.take),risk=stopOn?Math.abs(entry-p.stop):null,reward=takeOn?Math.abs(p.take-entry):null,notional=p.notional??(Number(els.notional.value)||0);
  const parts=[];if(stopOn)parts.push(`止损风险 ${pretty(entry>0?notional*risk/entry:NaN)} U`);else parts.push('止损未设置');if(takeOn)parts.push(`止盈空间 ${pretty(entry>0?notional*reward/entry:NaN)} U`);else parts.push('止盈未设置');
  const ratio=stopOn&&takeOn&&risk>0&&reward>0?` · ${pretty(reward/risk,2)}R`:'';els['risk-preview'].textContent=`${parts.join(' · ')}${ratio}`;
  if(isDraft){const stopValid=p.stop===null||validProtection(side,'stop',p.stop,entry),takeValid=p.take===null||validProtection(side,'take',p.take,entry),valid=entry>0&&stopValid&&takeValid&&Number(els.notional.value)>0;els['confirm-plan'].disabled=!valid;els['confirm-plan'].textContent=p.orderType==='limit'?`提交限价单 · ${side===1?'买入 / 做多':'卖出 / 做空'}`:`确认市价 · ${side===1?'买入 / 做多':'卖出 / 做空'}`;els['plan-hint'].textContent=p.orderType==='limit'?'点图选价；限价按指定价或更优成交，未触价时等待后续行情。图上的「＋止损」「＋止盈」可单独拖出。':'市价按当前回放收盘价成交。图上的「＋止损」「＋止盈」可单独拖出；拖动线可调整。';els['locate-plan'].hidden=false;}
}
function renderPlanOverlay(){
  if(overlayFrame)cancelAnimationFrame(overlayFrame);
  overlayFrame=requestAnimationFrame(()=>{overlayFrame=0;renderPlanOverlayNow();syncPlanOverlayCoordinates();schedulePlanProjection();});
}
function renderPlanOverlayNow(){
  if(!chartOverlay||!chart||!candleSeries)return;
  chartOverlay.replaceChildren();const p=effectivePlan();if(!p){syncPlanSummary();return;}
  const movableEntry=uiPlan?.orderType==='limit'||!!active?.pending;
  const entry=p.entryPrice??p.entry,prices=[['entry',entry,'入场价',movableEntry]];
  for(const [kind,label] of [['stop','止损'],['take','止盈']])if(Number.isFinite(p[kind]))prices.push([kind,p[kind],label,true]);
  const host=$('chart'),plotWidth=Math.max(0,host.clientWidth-66);
  for(const [key,price,label,movable] of prices){
    if(!Number.isFinite(price))continue;
    const y=candleSeries.priceToCoordinate(price);const initialY=Number.isFinite(y)?y:0;
    const previewing=dragState?.adding&&dragState.kind===key;
    const line=document.createElement('div');line.className=`plan-price-line ${key}${movable?'':' locked'}${previewing?' preview':''}`;line.dataset.kind=key;line.style.top=`${initialY}px`;line.style.right='66px';line.hidden=!Number.isFinite(y);
    const tag=document.createElement('span');tag.className=`plan-price-label ${key}${movable?'':' locked'}${previewing?' preview':''}`;tag.dataset.kind=key;tag.textContent=`${label}  ${pretty(price)}`;tag.style.top=`${Math.max(1,initialY-13)}px`;tag.style.right='70px';tag.hidden=!Number.isFinite(y);
    if(movable){const handle=document.createElement('button');handle.type='button';handle.className='plan-price-handle';handle.dataset.kind=key;handle.style.top=`${initialY}px`;handle.style.left=`${Math.max(4,plotWidth-11)}px`;handle.setAttribute('role','slider');handle.setAttribute('aria-label',`拖动${label}价格线`);handle.setAttribute('aria-valuenow',String(price));handle.title=`${label} ${pretty(price)} · 方向键微调`;handle.hidden=!Number.isFinite(y);
      handle.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();pauseForChartEdit();dragState={kind:key};dragDraft=clone(effectivePlan());const step=Math.max(price*0.0001,0.01);updatePlanDraft(key,price+(event.key==='ArrowUp'?step:-step));commitPlanDraft();});chartOverlay.append(line,tag,handle);
      if(key!=='entry'){
        const remove=document.createElement('button');remove.type='button';remove.className=`protection-remove ${key}`;remove.dataset.kind=key;remove.textContent='×';remove.setAttribute('aria-label',`取消${label}`);remove.title=`取消${label}`;remove.style.top=`${initialY}px`;remove.hidden=!Number.isFinite(y);chartOverlay.append(remove);
      }
    }else chartOverlay.append(line,tag);
  }
  for(const [kind,label,gapFromRight] of [['stop','止损',320],['take','止盈',220]])if(p[kind]===null){
    const y=candleSeries.priceToCoordinate(entry),marker=document.createElement('button');marker.type='button';marker.className=`protection-add-marker ${kind}`;marker.dataset.kind=kind;marker.textContent=`＋${label}`;marker.setAttribute('aria-label',`拖动以添加${label}`);marker.title=`按住并向${p.side===1?(kind==='stop'?'下':'上'):(kind==='stop'?'上':'下')}拖动，设置${label}`;marker.style.top=`${Number.isFinite(y)?y:0}px`;marker.style.left=`${Math.max(8,plotWidth-gapFromRight)}px`;marker.hidden=!Number.isFinite(y);chartOverlay.append(marker);
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
    if(line)line.style.top=`${y}px`;
    if(tag){tag.style.top=`${Math.max(1,y-13)}px`;tag.textContent=`${kind==='entry'?'入场价':kind==='stop'?'止损':'止盈'}  ${pretty(price)}`;}
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
  chartOverlay.addEventListener('pointerdown',event=>{if(event.target.closest('.protection-remove')){event.preventDefault();event.stopPropagation();return;}const target=event.target.closest('.plan-price-handle,.plan-price-label,.plan-price-line,.protection-add-marker');if(!target||target.classList.contains('locked'))return;event.preventDefault();event.stopPropagation();pauseForChartEdit();dragDraft=clone(effectivePlan());frozenPlanLevels=getPlanLevels();dragState={kind:target.dataset.kind,adding:target.classList.contains('protection-add-marker'),startY:event.clientY};chartOverlay.setPointerCapture(event.pointerId);});
  chartOverlay.addEventListener('pointermove',event=>{if(!dragState)return;event.preventDefault();event.stopPropagation();const rect=$('chart').getBoundingClientRect(),value=candleSeries.coordinateToPrice(event.clientY-rect.top);if(!Number.isFinite(value)||value<=0)return;if(dragState.adding){const moved=Math.abs(event.clientY-dragState.startY)>=6;dragDraft[dragState.kind]=moved&&protectionPreviewValid(dragState.kind,value,dragDraft)?value:null;renderPlanOverlay();}else updatePlanDraft(dragState.kind,value);});
  chartOverlay.addEventListener('pointerup',event=>{if(!dragState)return;event.preventDefault();event.stopPropagation();if(chartOverlay.hasPointerCapture(event.pointerId))chartOverlay.releasePointerCapture(event.pointerId);if(dragState.adding&&!Number.isFinite(dragDraft?.[dragState.kind])){dragState=null;dragDraft=null;frozenPlanLevels=null;renderPlanOverlay();return;}commitPlanDraft();});
  chartOverlay.addEventListener('pointercancel',()=>{dragState=null;dragDraft=null;frozenPlanLevels=null;chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();});
  chartOverlay.addEventListener('click',event=>{const target=event.target.closest('.protection-remove');if(!target)return;event.preventDefault();event.stopPropagation();removeProtection(target.dataset.kind);});
}
function pauseForChartEdit(){if(isPlaying){pause(false);els.play.textContent='▶';els.play.setAttribute('aria-label','自动播放');}}
function setPlanEntry(price){if(!uiPlan)return;const old=uiPlan.entryPrice,stopPct=Number.isFinite(uiPlan.stop)?Math.abs(old-uiPlan.stop)/old:null,takePct=Number.isFinite(uiPlan.take)?Math.abs(uiPlan.take-old)/old:null;uiPlan.entryPrice=price;uiPlan.stop=stopPct===null?null:price*(1-uiPlan.side*stopPct);uiPlan.take=takePct===null?null:price*(1+uiPlan.side*takePct);active.draftPlan=clone(uiPlan);chart.priceScale('right').applyOptions({autoScale:true});renderPlanOverlay();persist();}
function updatePlanDraft(kind,value){
  const target=dragDraft||uiPlan;if(!target)return;
  const entry=target.entryPrice??target.entry,anchor=active?.position&&!uiPlan&&!active?.pending?(currentData()[active.cursor]?.[4]??entry):entry,epsilon=Math.max(anchor*1e-6,0.01);
  if(kind==='entry'){const delta=value-entry;if('entryPrice'in target)target.entryPrice=value;else target.entry=value;if(Number.isFinite(target.stop))target.stop+=delta;if(Number.isFinite(target.take))target.take+=delta;}
  else if(kind==='stop')target.stop=target.side===1?Math.min(value,anchor-epsilon):Math.max(value,anchor+epsilon);
  else target.take=target.side===1?Math.max(value,anchor+epsilon):Math.min(value,anchor-epsilon);
  syncPlanOverlayCoordinates();
}
function removeProtection(kind){
  if(!['stop','take'].includes(kind)||!active)return;
  const p=effectivePlan();if(!p||!Number.isFinite(p[kind]))return;
  pauseForChartEdit();
  try{
    if(uiPlan){uiPlan[kind]=null;active.draftPlan=clone(uiPlan);}
    else if(active.pending)updatePendingOrder(active,currentData(),active.pending.entryPrice,kind==='stop'?null:active.pending.stop,kind==='take'?null:active.pending.take);
    else if(active.position)updateProtection(active,currentData(),kind==='stop'?null:active.position.stop,kind==='take'?null:active.position.take);
    chart.priceScale('right').applyOptions({autoScale:true});render(false,false);persist();
  }catch(error){toast(error.message||`无法取消${kind==='stop'?'止损':'止盈'}`);render(false,false);}
}
function commitPlanDraft(){
  if(!dragState)return;
  dragState=null;let updateResult=null;frozenPlanLevels=null;
  try{
    if(uiPlan){uiPlan=clone(dragDraft);active.draftPlan=clone(uiPlan);}
    else if(active?.pending){updateResult=updatePendingOrder(active,currentData(),dragDraft.entryPrice??dragDraft.entry,dragDraft.stop,dragDraft.take);}
    else if(active?.position){updateResult=updateProtection(active,currentData(),dragDraft.stop,dragDraft.take);}
    dragDraft=null;chart.priceScale('right').applyOptions({autoScale:true});render(false,false);persist();
    if(updateResult?.status==='filled')toast('限价单改价后立即成交，模拟持仓已建立');
  }catch(error){dragDraft=null;toast(error.message||'价格线调整未通过校验');renderPlanOverlay();}
}
function initChart(){
  const host=$('chart');
  chart=createChart(host,{width:host.clientWidth||800,height:host.clientHeight||418,layout:{background:{type:ColorType.Solid,color:'#171b1e'},textColor:'#879397',fontFamily:'Inter, -apple-system, sans-serif',fontSize:12},grid:{vertLines:{color:'#22292c'},horzLines:{color:'#22292c'}},crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#566469',labelBackgroundColor:'#39474b'},horzLine:{color:'#566469',labelBackgroundColor:'#39474b'}},rightPriceScale:{borderColor:'#313a3d',scaleMargins:{top:.12,bottom:.1}},timeScale:{borderColor:'#313a3d',timeVisible:true,secondsVisible:false,tickMarkFormatter:(time)=>formatChartTime(time),rightOffset:4,barSpacing:7},localization:{locale:'zh-CN',timeFormatter:(time)=>formatChartTime(time),priceFormatter:(price)=>pretty(price,2)}});
  candleSeries=chart.addSeries(CandlestickSeries,{upColor:'#22c58b',downColor:'#f06d78',borderUpColor:'#22c58b',borderDownColor:'#f06d78',wickUpColor:'#22c58b',wickDownColor:'#f06d78',priceLineVisible:false,autoscaleInfoProvider:original=>{const info=original?.();if(!info?.priceRange)return info;const levels=getPlanLevels();if(!levels.length)return info;return {...info,priceRange:{minValue:Math.min(info.priceRange.minValue,...levels),maxValue:Math.max(info.priceRange.maxValue,...levels)}};}});
  maSeries=chart.addSeries(LineSeries,{color:'#e6ba69',lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});
  chart.subscribeCrosshairMove(param=>{if(!active||!param.time)return;const bar=param.seriesData.get(candleSeries);if(!bar)return;els['ohlc'].textContent=`${showTime(Number(param.time))}  O ${pretty(bar.open)}  H ${pretty(bar.high)}  L ${pretty(bar.low)}  C ${pretty(bar.close)}`;});
  chart.subscribeClick(param=>{if(!uiPlan||uiPlan.orderType!=='limit'||!param.point||!chartOverlay)return;const rect=host.getBoundingClientRect(),y=param.point.y;if(y<0||y>rect.height-28)return;const price=candleSeries.coordinateToPrice(y);if(Number.isFinite(price)&&price>0)setPlanEntry(price);});
  chartOverlay=document.createElement('div');chartOverlay.className='price-line-overlay';chartOverlay.setAttribute('aria-label','入场与风险价格线');host.append(chartOverlay);
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
  const key=maSignature();
  if(maDataKey!==key){maSeries.setData(computeMa(bars));maDataKey=key;}
  maSeries.applyOptions({visible:!!active.ma});
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
  els.ohlc.textContent=`${showTime(bar.time)}  O ${pretty(bar.open)}  H ${pretty(bar.high)}  L ${pretty(bar.low)}  C ${pretty(bar.close)}`;
}
function putCell(row,text,className=''){const cell=document.createElement('td');cell.textContent=text;if(className)cell.className=className;row.append(cell);return cell;}
function renderTradeTable(trades,symbol,session){
  if(!trades.length){const empty=document.createElement('div');empty.className='empty-journal';empty.textContent='还没有已平仓成交。开仓后推进行情，或手动平仓记录结果。';els['journal-content'].append(empty);return;}
  const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table');
  const thead=document.createElement('thead'),hr=document.createElement('tr');['方向','开仓时间','开仓价','平仓时间','平仓价','盈亏 USDT','平仓原因'].forEach(t=>{const th=document.createElement('th');th.textContent=t;hr.append(th);});thead.append(hr);table.append(thead);
  const body=document.createElement('tbody');
  for(const t of [...trades].reverse()){
    const tr=document.createElement('tr');putCell(tr,`${symbol.replace('USDT','')} ${t.side===1?'做多':'做空'}`,t.side===1?'positive':'negative');
    putCell(tr,showTime(t.entryTime,session?.blind,session),'num');putCell(tr,pretty(t.entry),'num');putCell(tr,showTime(t.exitTime,session?.blind,session),'num');putCell(tr,pretty(t.exit),'num');putCell(tr,pretty(t.pnl),`num ${t.pnl>=0?'positive':'negative'}`);putCell(tr,t.reason);body.append(tr);
  }
  table.append(body);wrap.append(table);els['journal-content'].append(wrap);
}
function renderJournal(){
  els['journal-content'].replaceChildren();
  els['journal-count'].textContent=String(active?.trades?.length||0);els['history-count'].textContent=String(history.length);
  $('position-count').textContent=String(active?.position?1:0);$('order-count').textContent=String((active?.pending?1:0)+(active?.orderHistory?.length||0));
  for(const [id,mode] of [['positions-tab','positions'],['orders-tab','orders'],['current-tab','current'],['history-tab','history']])$(id).classList.toggle('selected',journalMode===mode);
  if(journalMode==='positions'){
    const p=active?.position;if(!p){const empty=document.createElement('div');empty.className='empty-journal';empty.textContent='当前没有持仓。已提交的限价订单会显示在“订单”中。';els['journal-content'].append(empty);}else{const box=document.createElement('div');box.className='table-wrap';const row=document.createElement('div');row.className='order-row';const text=document.createElement('span');text.textContent=`${active.symbol.replace('USDT','')} ${p.side===1?'买入 / 做多':'卖出 / 做空'} · 入场 ${pretty(p.entry)} · 止损 ${protectionText(p.stop)} · 止盈 ${protectionText(p.take)} · ${pretty(p.notional)} USDT`;const close=document.createElement('button');close.textContent='市价平仓';close.addEventListener('click',()=>{pause();closePosition(active,currentData());render();persist();});row.append(text,close);box.append(row);els['journal-content'].append(box);}els.notes.disabled=!active;els.notes.value=active?.notes||'';return;
  }
  if(journalMode==='orders'){
    const orders=[...(active?.orderHistory||[])].reverse();if(active?.pending)orders.unshift({...active.pending,status:'pending'});
    if(!orders.length){const empty=document.createElement('div');empty.className='empty-journal';empty.textContent='本轮还没有待成交或已处理订单。';els['journal-content'].append(empty);}
    else{const list=document.createElement('div');list.className='history-list';for(const order of orders){const row=document.createElement('div');row.className='history-card';const title=document.createElement('strong');title.textContent=`${order.side===1?'买入 / 做多':'卖出 / 做空'} · ${order.type==='limit'?'限价':'市价'} · ${order.status==='pending'?'等待触价':order.status==='filled'?'已成交':'已撤销'}`;const detail=document.createElement('span');detail.textContent=`入场 ${pretty(order.entryPrice)} · 止损 ${protectionText(order.stop)} · 止盈 ${protectionText(order.take)} · ${pretty(order.notional)} U${order.reason?` · ${order.reason}`:''}`;row.append(title,detail);if(order.status==='pending'){const cancel=document.createElement('button');cancel.textContent='撤销';cancel.addEventListener('click',()=>{cancelOrder(active,'用户撤单');render();persist();});row.append(cancel);}list.append(row);}els['journal-content'].append(list);}els.notes.disabled=true;els.notes.value='';return;
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
function renderPosition(){
  const p=active?.position,pending=active?.pending;
  els.position.replaceChildren();
  if(!p&&!pending){els.position.className='position-empty';const plus=document.createElement('span');plus.className='empty-cross';plus.textContent='＋';const line=document.createElement('p');line.textContent='等待你的判断';const hint=document.createElement('span');hint.textContent='市价单立即成交；限价按指定价或更优成交，否则挂起等待';els.position.append(plus,line,hint);els['position-badge'].textContent='空仓';return;}
  if(pending){
    els.position.className='position-pending';els['position-badge'].textContent='限价待成交';els['position-badge'].className='';
    const top=document.createElement('div');top.className='pos-top';const side=document.createElement('span');side.textContent=`${active.symbol.replace('USDT','')} ${pending.side===1?'买入 / 做多':'卖出 / 做空'}`;const amount=document.createElement('span');amount.textContent=`${pretty(pending.notional)} U`;top.append(side,amount);
    const dl=document.createElement('dl');for(const [label,value] of [['限价',pretty(pending.entryPrice)],['止损价',protectionText(pending.stop)],['止盈价',protectionText(pending.take)]]){const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;dl.append(dt,dd);}
    const locate=document.createElement('button');locate.className='cancel-pending';locate.textContent='定位订单线';locate.addEventListener('click',locatePlanPrices);
    const cancel=document.createElement('button');cancel.className='cancel-pending';cancel.textContent='撤销限价单';cancel.addEventListener('click',()=>{pause();cancelOrder(active,'用户撤单');chart.priceScale('right').applyOptions({autoScale:true});render();persist();toast('限价单已撤销');});els.position.append(top,dl,locate,cancel);return;
  }
  els.position.className='position-live';els['position-badge'].textContent=p.side===1?'做多持仓':'做空持仓';els['position-badge'].className=p.side===1?'positive':'negative';
  const top=document.createElement('div');top.className='pos-top';const side=document.createElement('span');side.textContent=`${active.symbol.replace('USDT','')} ${p.side===1?'买入 / 做多':'卖出 / 做空'}`;const amount=document.createElement('span');amount.textContent=`${pretty(p.notional)} U`;top.append(side,amount);
  const dl=document.createElement('dl');for(const [label,value] of [['入场价',pretty(p.entry)],['止损价',protectionText(p.stop)],['止盈价',protectionText(p.take)],['数量',pretty(p.qty,6)]]){const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;dl.append(dt,dd);}
  const locate=document.createElement('button');locate.className='cancel-pending';locate.textContent='定位持仓线';locate.addEventListener('click',locatePlanPrices);
  const close=document.createElement('button');close.type='button';close.className='close-position';close.textContent='市价平仓';close.addEventListener('click',()=>{pause();const trade=closePosition(active,currentData());if(trade){chart.priceScale('right').applyOptions({autoScale:true});render();persist();toast(`已市价平仓，盈亏 ${pretty(trade.pnl)} USDT`);}});
  els.position.append(top,dl,locate,close);
}
function render(resetRange=false,updateChart=true){
  if(!active)return;
  const data=currentData(),m=metrics(active,data),price=data[active.cursor]?.[4]||0;
  els.equity.textContent=pretty(m.equity);els.pnl.replaceChildren();const pnlText=document.createTextNode(pretty(m.pnl));const pct=document.createElement('em');pct.textContent=`${m.pnl>=0?'+':''}${pretty(m.pnl/INITIAL*100)}%`;els.pnl.append(pnlText,pct);els.pnl.className=m.pnl>=0?'positive':'negative';
  els.unreal.textContent=pretty(m.unreal);els.unreal.className=m.unreal>=0?'positive':'negative';els['trade-count'].textContent=`${active.trades.length} 笔成交`;els['win-rate'].textContent=m.winRate===null?'—':`${pretty(m.winRate,1)}%`;
  els.balance.textContent=`${pretty(active.balance)} USDT`;els['coin-mark'].textContent=active.symbol.startsWith('BTC')?'₿':'◆';els.symbol.value=active.symbol;els['session-badge'].textContent=`${active.symbol.replace('USDT','')} · ${TF_LABELS.get(active.tf)} · ${active.position?'持仓中':active.pending?'限价待成交':'盲回放'}`;
  document.querySelectorAll('[data-tf]').forEach(button=>button.classList.toggle('active',Number(button.dataset.tf)===active.tf));
  els.blind.checked=!!active.blind;els.ma.checked=!!active.ma;
  const span=Math.max(1,(data[active.end]?.[0]||0)-(data[active.start]?.[0]||0));const elapsed=Math.max(0,(data[active.cursor]?.[0]||0)-(data[active.start]?.[0]||0));const progressPct=Math.max(0,Math.min(100,elapsed/span*100));els['progress-bar'].style.width=`${progressPct}%`;
  els['progress-text'].textContent=`已回放 ${Math.min(180,Math.floor(elapsed/86400))} / 180 天 · ${TF_LABELS.get(active.tf)||''}`;
  const hasOrder=!!active.position||!!active.pending,ended=active.cursor>=active.end;els.play.disabled=ended||!!uiPlan;els.step.disabled=ended||!!uiPlan;els.long.disabled=ended||hasOrder;els.short.disabled=ended||hasOrder;els['size-range'].disabled=hasOrder;syncDirectionSelection();
  els.play.textContent=isPlaying?'Ⅱ':'▶';els.play.setAttribute('aria-label',isPlaying?'暂停回放':'自动播放');els['replay-status'].textContent=ended?'本轮结束':active.position?'持仓中':active.pending?'限价待成交':'盲回放';
  els['new-session'].disabled=false;els['order-hint'].textContent=active.position?'持仓期间不能重复下单':active.pending?'限价单等待后续行情满足价格条件':'市价立即成交；限价按指定价或更优成交，否则挂起等待';
  const sizePct=Number.isFinite(active.sizePercent)?active.sizePercent:10;els['size-range'].value=String(sizePct);syncSize(sizePct,false);
  $('market-type').classList.toggle('active',selectedOrderType==='market');$('limit-type').classList.toggle('active',selectedOrderType==='limit');$('market-type').disabled=hasOrder;$('limit-type').disabled=hasOrder;syncPlanSummary();
  const bars=disclosedBars();if(updateChart)renderChart(false,resetRange);else renderPlanOverlay();updateQuote(bars.at(-1));renderPosition();renderJournal();
}
function pause(renderAfter=true){isPlaying=false;clearTimeout(playTimer);if(renderAfter&&active&&!invalidSavedActive)render();}
function advanceOne(){
  if(transitionPending||uiPlan||!active||active.cursor>=active.end)return;
  const result=advance(active,currentData()),messages=[];
  if(result.orderFilled){pause(false);messages.push('限价单已成交，模拟持仓已建立');}
  if(result.orderCancelled)messages.push(`限价单已结束：${result.orderCancelled.reason||'本轮结束'}`);
  if(result.trade){pause(false);messages.push(`${result.trade.reason}，本笔 ${pretty(result.trade.pnl)} USDT`);}
  render();persist();
  if(isPlaying&&!result.ended&&!result.trade&&!result.orderFilled)playTimer=setTimeout(advanceOne,Number(els.speed.value));
  else if(result.ended){pause();messages.push('本轮行情已走完');}
  if(messages.length)toast(messages.join(' · '));
}
function togglePlay(){if(transitionPending||uiPlan)return;if(isPlaying){pause();return;}if(!active||active.cursor>=active.end)return;isPlaying=true;render();playTimer=setTimeout(advanceOne,Number(els.speed.value));}
function archiveActive(){
  if(!active)return;
  if(active.pending)cancelOrder(active,'新一轮开始，未成交挂单撤销');
  if(active.position){try{closePosition(active,currentData(),currentData()[active.cursor][4],'新一轮前手动平仓');}catch{}}
  let result=null;try{if(!invalidSavedActive)result=metrics(active,currentData());}catch{}
  active.draftPlan=null;uiPlan=null;
  const item={id:active.id,session:clone(active),metrics:result,archivedAt:new Date().toISOString()};history.push(item);invalidSavedActive=false;
}
async function startRound(symbol=active?.symbol||els.symbol.value){
  if(transitionPending)return false;
  transitionPending=true;
  els['new-session'].disabled=true;els.play.disabled=true;els.step.disabled=true;els.long.disabled=true;els.short.disabled=true;els.symbol.disabled=true;
  try{
    pause();
    const data=await loadSymbol(symbol);
    const candidate=createSession(symbol,data);
    archiveActive();candidate.startTime=data[candidate.start][0]+BASE;candidate.sizePercent=10;active=candidate;selectedOrderType='market';pendingSymbol=null;journalMode='positions';selectedHistoryId=null;els.symbol.value=symbol;hideLoading();render(true);persist();return true;
  }catch(error){
    toast(`新一轮暂未开始：${error.message}。现有练习和往期记录已保留。`);els.symbol.value=active?.symbol||'BTCUSDT';if(invalidSavedActive)showSavedRecordRecovery(error.message);else{hideLoading();if(active)render();}return false;
  }finally{transitionPending=false;els.symbol.disabled=false;if(active&&!invalidSavedActive)els['new-session'].disabled=false;else if(!active)els['new-session'].disabled=false;}
}
function maybeStart(symbol){pendingSymbol=symbol;if(active?.position||active?.pending){$('new-dialog').showModal();return;}startRound(symbol);}
function downloadExport(){
  const payload={version:1,source:{marketData:'Binance 现货公开历史档案',symbols:['BTCUSDT','ETHUSDT'],interval:BASE,simulation:'本地练习记录，不代表真实成交'},exportedAt:new Date().toISOString(),current:active?clone(active):null,history:clone(history)};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`K线回放_记录_${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url);toast('练习记录 JSON 已导出');
}
function wireEvents(){
  els['new-session'].addEventListener('click',()=>maybeStart(active?.symbol||els.symbol.value));
  els['confirm-new'].addEventListener('click',()=>{$('new-dialog').close();startRound(pendingSymbol||active?.symbol||els.symbol.value);});
  $('new-dialog').addEventListener('close',()=>{if(pendingSymbol&&pendingSymbol!==active?.symbol)els.symbol.value=active?.symbol||'BTCUSDT';pendingSymbol=null;});
  els.symbol.addEventListener('change',()=>{maybeStart(els.symbol.value);});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
  document.querySelectorAll('[data-tf]').forEach(button=>button.addEventListener('click',()=>{if(!active||transitionPending)return;pause();active.tf=Number(button.dataset.tf);render(true);persist();}));
  els.ma.addEventListener('change',()=>{if(active){pause(false);active.ma=els.ma.checked;if(maDataKey!==maSignature()){maSeries.setData(computeMa(disclosedBars()));maDataKey=maSignature();}maSeries.applyOptions({visible:active.ma});els.play.textContent='▶';els.play.setAttribute('aria-label','自动播放');els['replay-status'].textContent=active.cursor>=active.end?'本轮结束':active.position?'持仓中':'盲回放';persist();}});
  els.blind.addEventListener('change',()=>{if(active){active.blind=els.blind.checked;render();persist();}});
  els.play.addEventListener('click',togglePlay);els.step.addEventListener('click',()=>{if(transitionPending)return;pause();advanceOne();});
  els.speed.addEventListener('change',()=>{if(isPlaying){pause();togglePlay();}});
  els.recenter.addEventListener('click',()=>chart?.timeScale().scrollToRealTime());
  els.long.addEventListener('click',()=>beginPlan(1));els.short.addEventListener('click',()=>beginPlan(-1));
  els['order-form'].addEventListener('submit',e=>e.preventDefault());
  els.notes.addEventListener('input',()=>{if(active){active.notes=els.notes.value;persist();}});
  for(const [id,mode] of [['positions-tab','positions'],['orders-tab','orders'],['current-tab','current'],['history-tab','history']])$(id).addEventListener('click',()=>{journalMode=mode;renderJournal();});
  document.querySelectorAll('[data-size]').forEach(button=>button.addEventListener('click',()=>syncSize(Number(button.dataset.size))));
  els['size-range'].addEventListener('input',()=>syncSize(Number(els['size-range'].value)));
  $('market-type').addEventListener('click',()=>chooseOrderType('market'));$('limit-type').addEventListener('click',()=>chooseOrderType('limit'));
  els['confirm-plan'].addEventListener('click',confirmPlan);els['cancel-plan'].addEventListener('click',cancelDraft);els['locate-plan'].addEventListener('click',locatePlanPrices);
  els.export.addEventListener('click',downloadExport);els.rules.addEventListener('click',()=>els['info-dialog'].showModal());els['source-details'].addEventListener('click',()=>{$('info-dialog').showModal();$('info-dialog').querySelector('details').open=true;});
  document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select')||$('info-dialog').open||$('new-dialog').open)return;if(e.code==='Space'){e.preventDefault();togglePlay();}else if(e.key==='ArrowRight'){e.preventDefault();pause();advanceOne();}});
}
async function boot(){
  readSaved();initChart();wireEvents();
  if(active){
    try{const data=await loadSymbol(active.symbol);if(!validateSession(active,active.symbol,data))throw new Error('保存的练习状态校验失败，记录已保留');invalidSavedActive=false;if(!active.startTime)active.startTime=data[active.start][0]+BASE;selectedOrderType=active.selectedOrderType||'market';if(active.draftPlan){uiPlan=clone(active.draftPlan);selectedOrderType=uiPlan.orderType||selectedOrderType;els['plan-actions'].hidden=false;}hideLoading();render(true);persist();return;}
    catch(error){invalidSavedActive=true;showSavedRecordRecovery(error.message);return;}
  }
  const symbol=active?.symbol||'BTCUSDT';
  try{await loadSymbol(symbol);await startRound(symbol);}
  catch(error){setLoading(`${error.message}。检查网络或数据文件后重试。`,true);els['new-session'].disabled=false;}
}
async function retryRecovery(){
  const symbol=active?.symbol||els.symbol.value;
  try{await loadSymbol(symbol,true);if(active&&!validateSession(active,symbol,datasets.get(symbol)))throw new Error('保存的练习状态校验失败');invalidSavedActive=false;if(active&&!active.startTime)active.startTime=datasets.get(symbol)[active.start][0]+BASE;hideLoading();if(active){render(true);persist();}else await startRound(symbol);}
  catch(error){setLoading(`${error.message}。本地记录仍保留，可再次重试，或导出备份。`,true);}
}
boot();
