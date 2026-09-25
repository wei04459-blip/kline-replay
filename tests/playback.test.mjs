import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/app.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function syncPlaybackControls(){');
const end = source.indexOf('\nfunction archiveActive(){', start);
assert.ok(start >= 0 && end > start, 'playback functions should remain in the expected app section');
const playbackSource = source.slice(start, end);
const reasonResumeStart = source.indexOf('function resumeReasonPlayback(){');
const reasonResumeEnd = source.indexOf('\nasync function submitOrderReason(){', reasonResumeStart);
assert.ok(reasonResumeStart >= 0 && reasonResumeEnd > reasonResumeStart, 'reason resume helper should remain identifiable');
const reasonResumeSource = source.slice(reasonResumeStart, reasonResumeEnd);

function harness({results = [], nextMinute, tf = 180, time = 0} = {}) {
  const timers = [], toasts = [];
  const active = {id: 'session-1', symbol: 'BTCUSDT', cursor: 0, time, tf, end: 100, ended: false};
  const data = [];
  const state = {
    active, data, pendingOrderRequest: null, transitionPending: false, invalidSavedActive: false, uiPlan: null, modificationDraft: null,
    isPlaying: false, reasonResumePlayback: false, fastForwarding: false, minuteActionPending: false, minuteRetryAction: null,
    minuteGeneration: 0, minuteRequestId: 0, playTimer: 0,
    advanceCount: 0, renderCount: 0, persistCount: 0, draftSyncCount: 0,
    events: [...results], timers, toasts
  };
  const controls = {
    play: {disabled: false, textContent: '', setAttribute() {}},
    'step-minute': {disabled: false}, step: {disabled: false}, 'cancel-advance': {hidden: true},
    'retry-minute': {hidden: true}, 'progress-text': {textContent: ''}, 'progress-bar': {style: {width: ''}},
    speed: {value: '1'}
  };
  const sandbox = {
    els: controls,
    replayIsEnded: (s = active) => !!s.ended,
    replayClock: (s = active) => s.time,
    currentData: () => data,
    intervalStart: (value, seconds) => Math.floor(value / seconds) * seconds,
    nextMinute: nextMinute || (async (_symbol, afterTime) => [afterTime + 60, 100, 101, 99, 100, 1]),
    advanceMinute: (session, candle) => {
      state.advanceCount++;
      session.cursor++;
      session.time = candle[0] + 60;
      const result = state.events.shift() || {ended: false};
      if (result.ended) session.ended = true;
      return result;
    },
    syncDraftsAfterMinute: () => { state.draftSyncCount++; return false; },
    minuteResultMessage: (result, session) => {
      const coin = session.symbol.replace(/USDT$/, '');
      const messages = [];
      if (result.orderFilled) messages.push(`限价单已成交 · ${coin} · ${result.orderFilled.fillPrice}`);
      if (result.orderCancelled) messages.push(`限价单已结束 · ${coin}`);
      if (result.trade) messages.push(`${result.trade.reason} · ${coin} · 平仓 ${result.trade.exit} · 盈亏 ${result.trade.pnl}`);
      if (result.ended) messages.push('本轮行情已走完');
      return messages;
    },
    render: () => { state.renderCount++; },
    persist: () => { state.persistCount++; },
    syncReplayProgress: () => {},
    toast: message => toasts.push(message),
    pretty: value => String(value),
    FEE: 0.0004,
    setTimeout: callback => { const id = timers.length + 1; timers.push({id, callback}); return id; },
    clearTimeout: id => { const timer = timers.find(item => item.id === id); if (timer) timer.cancelled = true; }
  };
  for (const key of Object.keys(state)) Object.defineProperty(sandbox, key, {
    enumerable: true, get: () => state[key], set: value => { state[key] = value; }
  });
  vm.runInNewContext(`${playbackSource}\n${reasonResumeSource}\nglobalThis.playbackApi={syncPlaybackControls,pause,runAutomaticMinute,advanceOneMinuteCore,advanceOneMinute,advanceToTfBoundary,togglePlay,resumeReasonPlayback};`, sandbox);
  return {api: sandbox.playbackApi, state, sandbox, controls, timers, toasts};
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

test('automatic playback continues after limit fill and exit events, scheduling the next minute', async () => {
  const h = harness({results: [{
    ended: false,
    orderFilled: {side: 1, fillPrice: 100.25},
    trade: {side: 1, reason: '止损', exit: 98.5, pnl: -10}
  }]});
  h.state.isPlaying = true;
  await h.api.runAutomaticMinute(h.state.minuteGeneration);
  assert.equal(h.state.advanceCount, 1);
  assert.equal(h.state.isPlaying, true);
  assert.equal(h.state.minuteGeneration, 0);
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 1);
  assert.match(h.toasts[0], /BTC/);
  assert.match(h.toasts[0], /100\.25/);
  assert.match(h.toasts[0], /98\.5/);
});

test('automatic playback does not stop or invalidate after an order-cancel event', async () => {
  const h = harness({results: [{ended: false, orderCancelled: {side: -1, reason: '用户撤单'}}]});
  h.state.isPlaying = true;
  await h.api.runAutomaticMinute(h.state.minuteGeneration);
  assert.equal(h.state.minuteGeneration, 0);
  assert.equal(h.state.isPlaying, true);
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 1);
  assert.match(h.toasts[0], /BTC/);
  assert.match(h.toasts[0], /用户撤单/);
});

test('manual pause invalidates an in-flight minute fetch before it can mutate the session', async () => {
  const wait = deferred(), h = harness({nextMinute: () => wait.promise});
  const pending = h.api.advanceOneMinuteCore(h.state.minuteGeneration);
  await Promise.resolve();
  assert.equal(h.state.minuteActionPending, true);
  h.api.pause(false);
  wait.resolve([0, 100, 101, 99, 100, 1]);
  assert.equal(await pending, null);
  assert.equal(h.state.advanceCount, 0);
  assert.equal(h.state.minuteActionPending, false);
});

test('opening the order-reason window freezes a minute request even if its response arrives', async () => {
  const wait = deferred(), h = harness({nextMinute: () => wait.promise});
  const pending = h.api.advanceOneMinuteCore(h.state.minuteGeneration);
  await Promise.resolve();
  h.state.pendingOrderRequest = {side: 1};
  wait.resolve([0, 100, 101, 99, 100, 1]);
  assert.equal(await pending, null);
  assert.equal(h.state.advanceCount, 0);
  assert.equal(h.state.minuteActionPending, false);
});

test('new and modification drafts do not lock play or stepping', async () => {
  const h = harness();
  h.state.uiPlan = {orderType: 'market'};
  h.state.modificationDraft = {stop: 95};
  h.api.syncPlaybackControls();
  assert.equal(h.controls.play.disabled, false);
  assert.equal(h.controls['step-minute'].disabled, false);
  assert.equal(h.controls.step.disabled, false);
  h.api.togglePlay();
  assert.equal(h.state.isPlaying, true);
  await h.api.advanceOneMinute();
  assert.equal(h.state.advanceCount, 1);
  assert.equal(h.state.draftSyncCount, 1);
});

test('manual timeframe advance continues past order events and keeps their notice instead of overwriting it', async () => {
  const h = harness({tf: 180, results: [
    {ended: false, orderFilled: {side: 1, fillPrice: 100.2}},
    {ended: false, trade: {side: 1, reason: '止盈', exit: 105, pnl: 20}},
    {ended: false}
  ]});
  await h.api.advanceToTfBoundary();
  assert.equal(h.state.advanceCount, 3);
  assert.equal(h.state.active.time, 180);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /100\.2/);
  assert.match(h.toasts[0], /105/);
  assert.doesNotMatch(h.toasts[0], /已快进/);
});

test('natural end remains a stop and still announces the final trade after invalidating playback generation', async () => {
  const h = harness({results: [{ended: true, trade: {side: -1, reason: '本轮结束', exit: 99, pnl: -2}}]});
  h.state.isPlaying = true;
  await h.api.advanceToTfBoundary();
  assert.equal(h.state.active.ended, true);
  assert.equal(h.state.isPlaying, false);
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 0);
  assert.match(h.toasts.at(-1), /本轮结束/);
  assert.match(h.toasts.at(-1), /99/);
});

test('automatic playback stops naturally at end and the reason dialog resumes only prior playback', async () => {
  const h = harness({results: [{ended: true}]});
  h.state.isPlaying = true;
  await h.api.runAutomaticMinute(h.state.minuteGeneration);
  assert.equal(h.state.isPlaying, false);
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 0);

  const priorPlaying = harness();
  priorPlaying.state.reasonResumePlayback = true;
  priorPlaying.api.resumeReasonPlayback();
  assert.equal(priorPlaying.state.reasonResumePlayback, false);
  assert.equal(priorPlaying.state.isPlaying, true);
  assert.equal(priorPlaying.timers.filter(timer => !timer.cancelled).length, 1);

  const priorPaused = harness();
  priorPaused.state.reasonResumePlayback = false;
  priorPaused.api.resumeReasonPlayback();
  assert.equal(priorPaused.state.isPlaying, false);
  assert.equal(priorPaused.timers.length, 0);
});

test('minute read failure stops playback and preserves the retry affordance', async () => {
  const h = harness({nextMinute: async () => { throw new Error('网络中断'); }});
  h.state.isPlaying = true;
  await h.api.runAutomaticMinute(h.state.minuteGeneration);
  assert.equal(h.state.isPlaying, false);
  assert.equal(h.state.minuteRetryAction, 'minute');
  assert.equal(h.controls['retry-minute'].hidden, false);
  assert.match(h.toasts.at(-1), /网络中断/);
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 0);
});

function appSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `app section exists: ${startMarker}`);
  return source.slice(start, end);
}

const exitReasonSource = [
  appSection('function positionIdentity(p){', '\nfunction syncDrawingControls(){'),
  appSection('function setReasonCopy(mode){', '\nfunction reasonOrderSummary('),
  appSection('function closeOrderReason(returnFocus=true){', '\nfunction resumeReasonPlayback(){'),
  appSection('function resumeReasonPlayback(){', '\nasync function submitOrderReason(){'),
  appSection('async function submitOrderReason(){', '\nfunction entryReasonText(')
].join('\n');

function exitHarness({playing = true, startResult = false} = {}) {
  const events = [], toasts = [], controls = {};
  const active = {id: 'session-exit-1', symbol: 'BTCUSDT', position: {
    orderId: 'order-exit-1', side: 1, entry: 100, margin: 50, leverage: 2
  }, trades: []};
  const input = {
    value: '', placeholder: '', focusCount: 0, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }, focus() { this.focusCount++; }
  };
  controls['entry-reason'] = input;
  controls['reason-confirm'] = {disabled: false, textContent: ''};
  controls['entry-reason-error'] = {textContent: ''};
  controls['order-reason-window'] = {hidden: true, offsetWidth: 400, offsetHeight: 250, style: {}, classList: {toggle() {}}};
  controls['order-reason-summary'] = {textContent: ''};
  controls['reason-close'] = {setAttribute(name, value) { this[name] = value; }};
  controls['new-session'] = {isConnected: true, hidden: false, focus() {}};
  controls.symbol = {value: 'BTCUSDT'};
  controls.play = {textContent: '', setAttribute(name, value) { this[name] = value; }};
  controls['reason-confirm'].setAttribute = function(name, value) { this[name] = value; };
  controls['reason-confirm'].focus = () => {};
  controls['order-reason-drag'] = {};
  const state = {
    active, controls, pendingOrderRequest: null, reasonMode: 'entry', reasonSubmitting: false,
    reasonResumePlayback: false, reasonFocusReturn: null, reasonWindowDrag: null,
    pendingSymbol: 'ETHUSDT', invalidSavedActive: false, playing, startResult,
    closeCalls: 0, startCalls: [], renderCount: 0, persistCount: 0, persistedTrades: 0
  };
  const sandbox = {
    els: controls,
    $: id => controls[id],
    clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
    active,
    transitionPending: false,
    isPlaying: playing,
    reasonResumePlayback: false,
    reasonFocusReturn: null,
    reasonWindowDrag: null,
    reasonMode: 'entry',
    reasonSubmitting: false,
    pendingOrderRequest: null,
    pendingSymbol: 'ETHUSDT',
    invalidSavedActive: false,
    uiPlan: null,
    pause: () => { state.playing = false; sandbox.isPlaying = false; },
    replayMark: () => 98.75,
    recordLeverage: p => p?.leverage || 1,
    recordMargin: p => p?.margin || 0,
    pretty: value => Number(value).toFixed(2),
    setReasonCopy: mode => sandbox.copyFn(mode),
    copyFn: mode => {
      const exiting = mode === 'exit';
      controls['order-reason-title'].textContent = exiting ? '填写平仓理由' : '填写下单理由';
      controls['reason-prompt'].textContent = exiting ? '为什么现在主动平仓？' : '为什么在这里下单？';
      input.placeholder = exiting ? '写下主动退出的依据…' : '写下你的判断依据…';
      controls['reason-close'].setAttribute('aria-label', exiting ? '取消本次平仓' : '取消本次下单');
    },
    positionReasonWindow: () => {},
    syncReasonControls: () => {},
    syncPlaybackControls: () => {},
    requestAnimationFrame: callback => callback(),
    currentData: () => [],
    manualClosePosition: (session, _data, exitReason, price) => {
      state.closeCalls++;
      if (!exitReason.trim()) throw new Error('平仓理由必填');
      const trade = {reason: '手动平仓', exitReason, exit: price, side: session.position.side};
      session.trades.push(trade);
      session.position = null;
      return trade;
    },
    clearModificationDraft: () => {},
    chart: {priceScale: () => ({applyOptions() {}})},
    render: () => { state.renderCount++; },
    persist: () => { state.persistCount++; state.persistedTrades = active.trades.length; events.push('persist'); },
    toast: message => toasts.push(message),
    startRound: async symbol => { state.startCalls.push(symbol); events.push('start'); return state.startResult; },
    replayIsEnded: () => false,
    togglePlay: () => { state.playing = true; sandbox.isPlaying = true; events.push('resume'); },
    toasts, events
  };
  controls['order-reason-title'] = {textContent: ''};
  controls['reason-prompt'] = {textContent: ''};
  for (const key of Object.keys(state)) Object.defineProperty(sandbox, key, {
    enumerable: true,
    get: () => key === 'controls' ? controls : key === 'active' ? active : state[key],
    set: value => { state[key] = value; }
  });
  vm.runInNewContext(`${exitReasonSource}\nglobalThis.exitReasonApi={requestExitReason,closeOrderReason,submitOrderReason};`, sandbox);
  return {api: sandbox.exitReasonApi, state, sandbox, input, controls, events, toasts};
}

test('exit reason modal rejects blank text and leaves the position open', async () => {
  const h = exitHarness();
  assert.equal(h.api.requestExitReason(), true);
  assert.equal(h.controls['reason-confirm'].disabled, true);
  assert.equal(h.controls['reason-close']['aria-label'], '取消本次平仓');
  await h.api.submitOrderReason();
  assert.equal(h.state.closeCalls, 0);
  assert.ok(h.state.active.position);
  assert.equal(h.state.pendingOrderRequest.mode, 'exit');
  assert.match(h.controls['entry-reason-error'].textContent, /请填写平仓理由/);
});

test('canceling exit reason keeps the position and restores only prior playback', () => {
  const h = exitHarness({playing: true});
  h.api.requestExitReason();
  assert.equal(h.state.playing, false);
  h.api.closeOrderReason(false);
  assert.ok(h.state.active.position);
  assert.equal(h.state.pendingOrderRequest, null);
  assert.equal(h.state.playing, true);

  const paused = exitHarness({playing: false});
  paused.api.requestExitReason();
  paused.api.closeOrderReason(false);
  assert.equal(paused.state.playing, false);
});

test('confirming exit reason records it separately and resumes prior playback', async () => {
  const h = exitHarness({playing: true});
  h.api.requestExitReason();
  h.input.value = '交易结构失效，主动退出';
  await h.api.submitOrderReason();
  assert.equal(h.state.closeCalls, 1);
  assert.equal(h.state.active.position, null);
  assert.equal(h.state.active.trades[0].reason, '手动平仓');
  assert.equal(h.state.active.trades[0].exitReason, '交易结构失效，主动退出');
  assert.equal(h.state.pendingOrderRequest, null);
  assert.equal(h.state.persistedTrades, 1);
  assert.equal(h.state.playing, true);
  assert.match(h.toasts[0], /主动平仓已成交/);
});

test('stale position identity blocks an exit confirmation without mutating the session', async () => {
  const h = exitHarness({playing: false});
  h.api.requestExitReason();
  h.input.value = '计划失效';
  h.state.active.position.orderId = 'replacement-order';
  await h.api.submitOrderReason();
  assert.equal(h.state.closeCalls, 0);
  assert.equal(h.state.active.position.orderId, 'replacement-order');
  assert.equal(h.state.pendingOrderRequest.mode, 'exit');
  assert.match(h.controls['entry-reason-error'].textContent, /持仓状态已变化/);
});

test('archive exit captures its target and preserves the closed trade if starting the next round fails', async () => {
  const h = exitHarness({playing: true, startResult: false});
  h.api.requestExitReason({archiveSymbol: 'ETHUSDT'});
  h.state.pendingSymbol = 'BTCUSDT';
  h.input.value = '完成本轮计划';
  await h.api.submitOrderReason();
  assert.deepEqual(h.state.startCalls, ['ETHUSDT']);
  assert.equal(h.state.active.position, null);
  assert.equal(h.state.active.trades[0].exitReason, '完成本轮计划');
  assert.equal(h.state.persistedTrades, 1);
  assert.ok(h.events.indexOf('persist') < h.events.indexOf('start'));
  assert.equal(h.state.playing, true);
});

const startRoundSource = appSection('async function startRound(symbol=active?.symbol||els.symbol.value){', '\nfunction maybeStart(symbol)');

function roundTransitionHarness({loadFails = false} = {}) {
  const state = {
    active: {id: 'old-round', symbol: 'BTCUSDT', start: 0, end: 1},
    transitionPending: false, isPlaying: false, invalidSavedActive: false,
    pendingOrderRequest: null, selectedOrderType: 'market', pendingSymbol: null,
    journalMode: 'positions', selectedHistoryId: null, refreshCount: 0,
    overlayPointerEvents: 'auto', drawingDisabled: false
  };
  const controls = Object.fromEntries(['new-session','play','step','step-minute','long','short','symbol'].map(id => [id, {disabled: false, value: 'BTCUSDT'}]));
  const drawingTools = {
    refresh() {
      state.refreshCount++;
      state.overlayPointerEvents = state.transitionPending ? 'none' : 'auto';
      state.drawingDisabled = state.transitionPending;
    }
  };
  const candidate = {start: 0};
  const data = [[900, 100, 101, 99, 100, 1]];
  const sandbox = {
    els: controls, active: state.active, transitionPending: false, isPlaying: false,
    pendingOrderRequest: null, invalidSavedActive: false, selectedOrderType: 'market',
    pendingSymbol: null, journalMode: 'positions', selectedHistoryId: null,
    drawingTools, BASE: 900,
    pause: () => { state.isPlaying = false; sandbox.isPlaying = false; },
    loadSymbol: async () => { if (loadFails) throw new Error('minute archive unavailable'); return data; },
    createSession: () => candidate,
    clearModificationDraft() {}, archiveActive() {}, hideLoading() {}, persist() {},
    render() {
      drawingTools.refresh();
      state.drawingDisabled = state.transitionPending;
      sandbox.syncPlaybackControls();
    },
    toast() {}, currentData: () => data, metrics: () => ({}), clone: value => JSON.parse(JSON.stringify(value)),
    showSavedRecordRecovery() {}, replayIsEnded: () => false, togglePlay() {},
    syncDrawingControls() { for (const id of ['drawing-select','drawing-horizontal','drawing-trendline']) controls[id].disabled = state.transitionPending; },
    syncPlaybackControls() { for (const id of ['play','step','step-minute']) controls[id].disabled = state.transitionPending; },
    history: []
  };
  for (const key of ['active','transitionPending','isPlaying','pendingOrderRequest','invalidSavedActive','selectedOrderType','pendingSymbol','journalMode','selectedHistoryId']) {
    Object.defineProperty(sandbox, key, {enumerable: true, configurable: true, get: () => state[key], set: value => { state[key] = value; }});
  }
  for (const id of ['drawing-select','drawing-horizontal','drawing-trendline']) controls[id] = {disabled: false};
  vm.runInNewContext(`${startRoundSource}\nglobalThis.roundApi={startRound};`, sandbox);
  return {api: sandbox.roundApi, state, controls, drawingTools};
}

test('round transition refreshes drawing overlay and unlocks drawing controls after success', async () => {
  const h = roundTransitionHarness();
  assert.equal(await h.api.startRound('ETHUSDT'), true);
  assert.equal(h.state.transitionPending, false);
  assert.equal(h.state.overlayPointerEvents, 'auto');
  assert.equal(h.state.drawingDisabled, false);
  assert.equal(h.controls['drawing-select'].disabled, false);
  assert.equal(h.controls.play.disabled, false);
  assert.equal(h.controls.step.disabled, false);
  assert.equal(h.controls['step-minute'].disabled, false);
  assert.ok(h.state.refreshCount >= 2, 'the render during transition locks the layer, then finally refresh must unlock it');
});

test('failed round transition also refreshes and unlocks drawing overlay and controls', async () => {
  const h = roundTransitionHarness({loadFails: true});
  assert.equal(await h.api.startRound('ETHUSDT'), false);
  assert.equal(h.state.transitionPending, false);
  assert.equal(h.state.overlayPointerEvents, 'auto');
  assert.equal(h.controls['drawing-horizontal'].disabled, false);
  assert.equal(h.controls.play.disabled, false);
  assert.equal(h.controls.step.disabled, false);
  assert.ok(h.state.refreshCount >= 1, 'error render may run while locked, so finally must refresh the SVG layer');
});
