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
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.hidden = false; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    remove() {}
    getBoundingClientRect() { return {left: 0, top: 0}; }
    contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
    setPointerCapture() {}
    hasPointerCapture() { return true; }
    releasePointerCapture() {}
  }
  const documentListeners = {};
  globalThis.document = {createElement: tag => new FakeNode(tag), createElementNS: (_ns, tag) => new FakeNode(tag),
    addEventListener(type, fn) { (documentListeners[type] ??= []).push(fn); }, removeEventListener() {}};
  globalThis.window = {addEventListener() {}, removeEventListener() {}};
  globalThis.getComputedStyle = () => ({position: 'relative'});
  globalThis.ResizeObserver = class {observe() {} disconnect() {}};
  const container = new FakeNode('div');
  container.clientWidth = 1000; container.clientHeight = 400;
  const chart = {timeScale: () => ({width: () => 900, height: () => 28, logicalToCoordinate: logical => logical * 100,
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
    assert.equal(container.children.length, 4);
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
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.hidden = false; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    remove() {}
    getBoundingClientRect() { return {left: 0, top: 0}; }
    contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
    setPointerCapture() {}
    hasPointerCapture() { return true; }
    releasePointerCapture() {}
  }
  const keyListeners = {};
  const documentListeners = {};
  globalThis.document = {createElement: tag => new FakeNode(tag), createElementNS: (_ns, tag) => new FakeNode(tag),
    addEventListener(type, fn) { (documentListeners[type] ??= []).push(fn); }, removeEventListener() {}};
  globalThis.window = {addEventListener(type, fn) { keyListeners[type] = fn; }, removeEventListener() {}};
  globalThis.getComputedStyle = () => ({position: 'relative'});
  globalThis.ResizeObserver = class {observe() {} disconnect() {}};
  const container = new FakeNode('div'); container.clientWidth = 1000; container.clientHeight = 400;
  const chart = {timeScale: () => ({width: () => 900, height: () => 28, logicalToCoordinate: logical => logical * 100,
    coordinateToLogical: x => x / 100, subscribeVisibleLogicalRangeChange() {},
    unsubscribeVisibleLogicalRangeChange() {}, subscribeVisibleTimeRangeChange() {},
    unsubscribeVisibleTimeRangeChange() {}})};
  const series = {priceToCoordinate: price => 40000 - price, coordinateToPrice: y => 40000 - y};
  const session = {id: 'draft-test', drawings: []};
  const states = [];
  const tools = createDrawingTools({chart, series, container, getSession: () => session, getBars: () => bars15,
    getInterval: () => 900, onStateChange: state => states.push(state)});
  const overlay = container.children[0];
  const dispatch = (type, event) => { for (const fn of container.listeners[type] ?? []) fn(event); };
  const click = (x, y) => {
    const event = {button: 0, pointerId: 1, target: container, clientX: x, clientY: y,
      preventDefault() {}, stopPropagation() {}};
    dispatch('pointerdown', event); dispatch('pointerup', event);
  };
  try {
    tools.setTool('trendline');
    click(100, 200);
    assert.ok(overlay.children.some(node => node.attributes.class === 'drawing-start-marker'));
    dispatch('pointermove', {pointerId: 1, target: container, clientX: 300, clientY: 150});
    assert.ok(overlay.children.some(node => node.attributes.class === 'drawing-preview'));
    assert.ok(overlay.children.filter(node => node.attributes.class === 'drawing-preview')
      .every(node => node.style.pointerEvents === 'none'));
    click(300, 150);
    assert.equal(session.drawings.length, 1);
    assert.equal(session.drawings[0].type, 'trend');
    assert.notEqual(session.drawings[0].start.time, session.drawings[0].end.time);
    assert.equal(tools.getSelectedId(), session.drawings[0].id, 'finished line is selected for immediate drag');
    assert.equal(overlay.children.filter(node => node.attributes.class === 'drawing-hit-area').length, 1);
    assert.equal(states.at(-1).tool, null, 'completion exits the one-shot drawing tool');
    assert.equal(tools.consumeChartClick(), true, 'the placement click is isolated from chart order selection');
    assert.equal(tools.consumeChartClick(), false);
    const hit = overlay.children.find(node => node.attributes.class === 'drawing-hit-area');
    const originalStart = {...session.drawings[0].start};
    const dragDown = {button: 0, pointerId: 3, target: hit, clientX: 200, clientY: 175,
      preventDefault() {}, stopPropagation() {}};
    for (const fn of hit.listeners.pointerdown ?? []) fn(dragDown);
    for (const fn of overlay.listeners.pointermove ?? []) fn({...dragDown, target: overlay, clientX: 220, clientY: 185});
    for (const fn of overlay.listeners.pointerup ?? []) fn({...dragDown, target: overlay, clientX: 220, clientY: 185});
    assert.equal(session.drawings[0].start.time, originalStart.time + 180, 'the selected line can be dragged immediately');
    assert.equal(session.drawings[0].start.price, originalStart.price - 10);

    tools.setTool('trendline');
    const countBeforePan = session.drawings.length;
    const pan = {button: 0, pointerId: 2, target: container, clientX: 220, clientY: 210,
      preventDefault() {}, stopPropagation() {}};
    dispatch('pointerdown', pan);
    dispatch('pointermove', {...pan, clientX: 250, clientY: 210});
    dispatch('pointerup', {...pan, clientX: 250, clientY: 210});
    assert.equal(session.drawings.length, countBeforePan, 'a pan gesture does not place a trendline point');
    click(200, 210);
    assert.equal(states.at(-1).phase, 'end', 'after the first click the UI can explain the next step');
    keyListeners.keydown({key: 'Escape', target: {}, preventDefault() {}});
    assert.equal(session.drawings.length, 1, 'Esc cancels the unfinished segment');
    tools.destroy();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('price-axis plus freezes its price, draws one line, and isolates dismiss clicks', () => {
  const previous = {document: globalThis.document, window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver};
  class FakeNode {
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.hidden = false; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    remove() {}
    getBoundingClientRect() { return {left: 0, top: 0}; }
    contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
    setPointerCapture() {}
    hasPointerCapture() { return true; }
    releasePointerCapture() {}
  }
  const documentListeners = {}, keyListeners = {};
  globalThis.document = {createElement: tag => new FakeNode(tag), createElementNS: (_ns, tag) => new FakeNode(tag),
    addEventListener(type, fn) { (documentListeners[type] ??= []).push(fn); }, removeEventListener() {}};
  globalThis.window = {addEventListener(type, fn) { keyListeners[type] = fn; }, removeEventListener() {}};
  globalThis.getComputedStyle = () => ({position: 'relative'});
  globalThis.ResizeObserver = class {observe() {} disconnect() {}};
  const container = new FakeNode('div'); container.clientWidth = 1000; container.clientHeight = 400;
  const chart = {timeScale: () => ({width: () => 900, height: () => 28, logicalToCoordinate: logical => logical * 100,
    coordinateToLogical: x => x / 100, subscribeVisibleLogicalRangeChange() {},
    unsubscribeVisibleLogicalRangeChange() {}, subscribeVisibleTimeRangeChange() {},
    unsubscribeVisibleTimeRangeChange() {}})};
  const series = {priceToCoordinate: price => 40000 - price, coordinateToPrice: y => 40000 - y};
  const session = {id: 'axis-menu-test', drawings: []};
  const tools = createDrawingTools({chart, series, container, getSession: () => session, getBars: () => bars15,
    getInterval: () => 900, formatPrice: value => value.toFixed(2)});
  const dispatch = (node, type, event) => { for (const fn of node.listeners[type] ?? []) fn(event); };
  const plus = container.children[2], menu = container.children[3], item = menu.children[0];
  try {
    dispatch(container, 'pointermove', {target: container, clientX: 500, clientY: 100});
    assert.equal(plus.hidden, false, 'hovering the plot shows the axis plus');
    assert.equal(plus.style.left, '876px', 'plus stays just left of the price scale');
    assert.equal(plus.style.top, '100px', 'plus center follows the hovered price');
    dispatch(container, 'pointermove', {target: container, clientX: 500, clientY: 390});
    assert.equal(plus.hidden, true, 'the time axis is not treated as a price area');
    dispatch(container, 'pointermove', {target: container, clientX: 500, clientY: 100});
    dispatch(plus, 'click', {preventDefault() {}, stopPropagation() {}});
    const frozenText = item.textContent;
    dispatch(container, 'pointermove', {target: container, clientX: 500, clientY: 160});
    assert.equal(item.textContent, frozenText, 'menu retains the price chosen before moving onto it');
    dispatch(item, 'click', {preventDefault() {}, stopPropagation() {}});
    assert.equal(session.drawings.length, 1);
    assert.equal(session.drawings[0].anchor.price, 39900);
    assert.equal(tools.getSelectedId(), session.drawings[0].id, 'new horizontal line is selected for immediate dragging');

    dispatch(container, 'pointermove', {target: container, clientX: 510, clientY: 120});
    dispatch(plus, 'click', {preventDefault() {}, stopPropagation() {}});
    const outside = new FakeNode('aside');
    const pointer = {target: outside, pointerId: 7};
    for (const fn of documentListeners.pointerdown ?? []) fn(pointer);
    for (const fn of documentListeners.pointerup ?? []) fn(pointer);
    assert.equal(menu.hidden, true, 'outside click closes the menu');
    assert.equal(tools.consumeChartClick(), false, 'an outside-of-chart click does not leave sticky suppression');
    assert.equal(session.drawings.length, 1, 'dismiss does not create another line');

    dispatch(container, 'pointermove', {target: container, clientX: 510, clientY: 120});
    dispatch(plus, 'click', {preventDefault() {}, stopPropagation() {}});
    const dismissOnChart = {target: container, pointerId: 8, button: 0, clientX: 450, clientY: 200};
    for (const fn of documentListeners.pointerdown ?? []) fn(dismissOnChart);
    dispatch(container, 'pointerdown', dismissOnChart);
    for (const fn of documentListeners.pointerup ?? []) fn(dismissOnChart);
    dispatch(container, 'pointerup', dismissOnChart);
    assert.equal(menu.hidden, true);
    assert.equal(tools.consumeChartClick(), true, 'the click that dismisses a menu is consumed by its own chart callback');
    const nextChartClick = {...dismissOnChart, pointerId: 9, clientY: 210};
    for (const fn of documentListeners.pointerdown ?? []) fn(nextChartClick);
    dispatch(container, 'pointerdown', nextChartClick);
    assert.equal(tools.consumeChartClick(), false, 'the next ordinary chart click remains available for limit-price selection');

    dispatch(container, 'pointermove', {target: container, clientX: 510, clientY: 120});
    dispatch(plus, 'click', {preventDefault() {}, stopPropagation() {}});
    keyListeners.keydown({key: 'Escape', target: {}, preventDefault() {}});
    assert.equal(menu.hidden, true, 'Escape cancels the menu');
    assert.equal(tools.consumeChartClick(), false, 'Escape does not suppress the next genuine chart click');

    globalThis.window.innerWidth = 1280; globalThis.window.innerHeight = 500;
    container.getBoundingClientRect = () => ({left: 25, top: 400});
    dispatch(container, 'pointermove', {target: container, clientX: 525, clientY: 520});
    dispatch(plus, 'click', {preventDefault() {}, stopPropagation() {}});
    assert.equal(menu.style.top, '58px', 'the menu is clamped to the visible viewport');
  } finally {
    tools.destroy();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
