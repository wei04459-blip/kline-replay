import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logicalToTimestamp, moveDrawingPoint, projectDrawing, sanitizeDrawings,
  timestampToLogical, translateDrawing, createDrawingTools,
} from '../dist/drawings.mjs';

const bars15 = Array.from({length: 5}, (_, i) => ({time: 1_700_000_000 + i * 900}));
const bars30 = [{time: 1_700_000_000}, {time: 1_700_001_800}, {time: 1_700_003_600}];

test('drawing sanitizer keeps valid records and drops bad items independently', () => {
  const valid = {id: 'h1', type: 'horizontal', anchor: {time: 1_700_000_000, price: 42000}};
  const result = sanitizeDrawings([valid, null,
    {...valid, id: 'bad-price', anchor: {time: 1, price: Infinity}},
    {...valid, id: 'bad-time', anchor: {time: 1.2, price: 1}},
    valid]);
  assert.deepEqual(result, [valid]);
});

test('trendlines need two valid points at distinct times', () => {
  assert.deepEqual(sanitizeDrawings([{id: 't1', type: 'trend', start: {time: 1, price: 5}, end: {time: 2, price: 7}}]),
    [{id: 't1', type: 'trend', start: {time: 1, price: 5}, end: {time: 2, price: 7}}]);
  assert.deepEqual(sanitizeDrawings([{id: 't2', type: 'trend', start: {time: 1, price: 5}, end: {time: 1, price: 7}}]), []);
});

test('timestamp and logical conversions interpolate timeframe aggregation both ways', () => {
  const t = 1_700_001_350;
  const logical15 = timestampToLogical(t, bars15, 900);
  assert.equal(logical15, 1.5);
  assert.equal(logicalToTimestamp(logical15, bars15, 900), t);
  assert.equal(timestampToLogical(t, bars30, 1800), 0.75);
  assert.equal(logicalToTimestamp(0.75, bars30, 1800), t);
});

test('conversions preserve timestamps between 15m bars and extrapolate future blank space', () => {
  const between = bars15[2].time + 450;
  const index = timestampToLogical(between, bars15, 900);
  assert.equal(index, 2.5);
  assert.equal(logicalToTimestamp(index, bars15, 900), between);
  assert.equal(logicalToTimestamp(7, bars15, 900), bars15[4].time + 3 * 900);
  const barsWithTailGap = [...bars15.slice(0, 4), {time: bars15[4].time + 3600}];
  assert.equal(logicalToTimestamp(5, barsWithTailGap, 900), barsWithTailGap.at(-1).time + 900,
    'future blank space uses timeframe even when the last disclosed candles are separated by a gap');
});

test('drawing projections map timestamps to logical coordinates without needing exact candle keys', () => {
  const drawing = {id: 'trend-1', type: 'trend',
    start: {time: bars15[1].time + 450, price: 42000},
    end: {time: bars15[3].time + 900, price: 43000}};
  assert.deepEqual(projectDrawing(drawing, bars30, 1800), {
    id: 'trend-1', type: 'trend', start: {logical: 0.75, price: 42000}, end: {logical: 2, price: 43000},
  });
});

test('whole-line translation preserves trend shape; endpoint move changes only that point', () => {
  const trend = {id: 'trend-2', type: 'trend', start: {time: 10, price: 100}, end: {time: 30, price: 120}};
  assert.deepEqual(translateDrawing(trend, 60, -5), {
    id: 'trend-2', type: 'trend', start: {time: 70, price: 95}, end: {time: 90, price: 115},
  });
  assert.deepEqual(moveDrawingPoint(trend, 'end', {time: 50, price: 130}), {
    id: 'trend-2', type: 'trend', start: trend.start, end: {time: 50, price: 130},
  });
  assert.equal(translateDrawing(trend, -60, -150), null, 'invalid pointer movement must not produce a drawable');
});

test('SVG renderer creates visible selected horizontal and trend lines with multi-token classes', () => {
  const previous = {document: globalThis.document, window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver};
  class FakeNode {
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    remove() {}
    getBoundingClientRect() { return {left: 0, top: 0}; }
  }
  globalThis.document = {createElementNS: (_ns, tag) => new FakeNode(tag)};
  globalThis.window = {addEventListener() {}, removeEventListener() {}};
  globalThis.getComputedStyle = () => ({position: 'relative'});
  globalThis.ResizeObserver = class {observe() {} disconnect() {}};
  const container = new FakeNode('div');
  container.clientWidth = 1000; container.clientHeight = 400;
  const chart = {timeScale: () => ({width: () => 900, logicalToCoordinate: logical => logical * 100,
    coordinateToLogical: x => x / 100, subscribeVisibleLogicalRangeChange() {},
    unsubscribeVisibleLogicalRangeChange() {}, subscribeVisibleTimeRangeChange() {},
    unsubscribeVisibleTimeRangeChange() {}})};
  const series = {priceToCoordinate: price => 40000 - price, coordinateToPrice: y => 40000 - y};
  const session = {id: 'render-test', drawings: [
    {id: 'h1', type: 'horizontal', anchor: {time: bars15[0].time, price: 39900}},
    {id: 't1', type: 'trend', start: {time: bars15[1].time, price: 39950}, end: {time: bars15[3].time, price: 39850}},
  ]};
  try {
    const tools = createDrawingTools({chart, series, container, getSession: () => session,
      getBars: () => bars15, getInterval: () => 900});
    assert.equal(container.children.length, 1);
    const overlay = container.children[0];
    const classes = overlay.children.map(node => node.attributes.class).filter(Boolean);
    assert.ok(classes.includes('drawing-line horizontal'));
    assert.ok(classes.includes('drawing-line trend'));
    assert.ok(overlay.children.some(node => node.attributes.stroke === 'transparent'));
    tools.destroy();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('trendline takes two clicks through preview and Escape clears an unfinished draft', () => {
  const previous = {document: globalThis.document, window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver};
  class FakeNode {
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    remove() {}
    getBoundingClientRect() { return {left: 0, top: 0}; }
  }
  const keyListeners = {};
  globalThis.document = {createElementNS: (_ns, tag) => new FakeNode(tag)};
  globalThis.window = {addEventListener(type, fn) { keyListeners[type] = fn; }, removeEventListener() {}};
  globalThis.getComputedStyle = () => ({position: 'relative'});
  globalThis.ResizeObserver = class {observe() {} disconnect() {}};
  const container = new FakeNode('div'); container.clientWidth = 1000; container.clientHeight = 400;
  const chart = {timeScale: () => ({width: () => 900, logicalToCoordinate: logical => logical * 100,
    coordinateToLogical: x => x / 100, subscribeVisibleLogicalRangeChange() {},
    unsubscribeVisibleLogicalRangeChange() {}, subscribeVisibleTimeRangeChange() {},
    unsubscribeVisibleTimeRangeChange() {}})};
  const series = {priceToCoordinate: price => 40000 - price, coordinateToPrice: y => 40000 - y};
  const session = {id: 'draft-test', drawings: []};
  const tools = createDrawingTools({chart, series, container, getSession: () => session, getBars: () => bars15,
    getInterval: () => 900});
  const overlay = container.children[0];
  const dispatch = (type, event) => { for (const fn of overlay.listeners[type] ?? []) fn(event); };
  const click = (x, y) => dispatch('pointerdown', {button: 0, target: overlay, clientX: x, clientY: y,
    preventDefault() {}, stopPropagation() {}});
  try {
    tools.setTool('trendline');
    click(100, 200);
    dispatch('pointermove', {clientX: 300, clientY: 150});
    assert.ok(overlay.children.some(node => node.attributes.class === 'drawing-preview'));
    assert.ok(overlay.children.filter(node => node.attributes.class === 'drawing-preview')
      .every(node => node.style.pointerEvents === 'none'));
    click(300, 150);
    assert.equal(session.drawings.length, 1);
    assert.equal(session.drawings[0].type, 'trend');
    assert.notEqual(session.drawings[0].start.time, session.drawings[0].end.time);

    tools.setTool('trendline');
    click(200, 210);
    keyListeners.keydown({key: 'Escape', target: {}, preventDefault() {}});
    assert.equal(session.drawings.length, 1, 'Esc cancels the unfinished segment');
    tools.destroy();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
