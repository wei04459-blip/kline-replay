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
const reasonResumeEnd = source.indexOf('\nfunction submitOrderReason(){', reasonResumeStart);
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
