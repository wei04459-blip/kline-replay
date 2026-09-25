const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_PRICE = Number.MIN_VALUE;
const MAX_DRAWINGS = 500;

function validPoint(point) {
  return point && Number.isSafeInteger(point.time) && point.time >= 0 &&
    Number.isFinite(point.price) && point.price > MIN_PRICE;
}

function cloneDrawing(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
      !/^[\w-]{1,80}$/.test(item.id)) return null;
  if (item.type === 'horizontal' && validPoint(item.anchor)) {
    return {id: item.id, type: item.type, anchor: {time: item.anchor.time, price: item.anchor.price}};
  }
  if (item.type === 'trend' && validPoint(item.start) && validPoint(item.end) &&
      item.start.time !== item.end.time) {
    return {id: item.id, type: item.type,
      start: {time: item.start.time, price: item.start.price},
      end: {time: item.end.time, price: item.end.price}};
  }
  return null;
}

/** Keep valid drawings only; callers can discard malformed drawing entries without invalidating a session. */
export function sanitizeDrawings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value.slice(0, MAX_DRAWINGS)) {
    const drawing = cloneDrawing(raw);
    if (!drawing || seen.has(drawing.id)) continue;
    seen.add(drawing.id);
    result.push(drawing);
  }
  return result;
}

function barTimes(bars) {
  return (Array.isArray(bars) ? bars : []).map(bar =>
    typeof bar === 'number' ? bar : bar?.time
  ).filter(Number.isFinite);
}

/** Map timestamp to fractional bar-index. The index interpolation survives timeframe aggregation. */
export function timestampToLogical(timestamp, bars, intervalSeconds = 60) {
  const times = barTimes(bars);
  if (!Number.isFinite(timestamp) || !times.length) return null;
  if (times.length === 1) return (timestamp - times[0]) / Math.max(1, intervalSeconds);
  let lo = 0, hi = times.length - 1;
  if (timestamp <= times[0]) {
    return (timestamp - times[0]) / Math.max(1, intervalSeconds);
  }
  if (timestamp >= times[hi]) {
    return hi + (timestamp - times[hi]) / Math.max(1, intervalSeconds);
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= timestamp) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  return span > 0 ? lo + (timestamp - times[lo]) / span : lo;
}

/** Inverse of timestampToLogical with the same piecewise-linear bar-time mapping. */
export function logicalToTimestamp(logical, bars, intervalSeconds = 60) {
  const times = barTimes(bars);
  if (!Number.isFinite(logical) || !times.length) return null;
  if (times.length === 1) return Math.round(times[0] + logical * Math.max(1, intervalSeconds));
  if (logical <= 0) {
    return Math.round(times[0] + logical * Math.max(1, intervalSeconds));
  }
  const last = times.length - 1;
  if (logical >= last) {
    return Math.round(times[last] + (logical - last) * Math.max(1, intervalSeconds));
  }
  const lo = Math.floor(logical), fraction = logical - lo;
  return Math.round(times[lo] + (times[lo + 1] - times[lo]) * fraction);
}

export function projectDrawing(drawing, bars, intervalSeconds = 60) {
  const valid = cloneDrawing(drawing);
  if (!valid) return null;
  const project = point => ({
    logical: timestampToLogical(point.time, bars, intervalSeconds),
    price: point.price,
  });
  if (valid.type === 'horizontal') return {id: valid.id, type: valid.type, anchor: project(valid.anchor)};
  return {id: valid.id, type: valid.type, start: project(valid.start), end: project(valid.end)};
}

function translatePoint(point, dt, dp) {
  return {time: Math.round(point.time + dt), price: point.price + dp};
}

/** Move full drawing in data coordinates. */
export function translateDrawing(drawing, dt, dp) {
  const valid = cloneDrawing(drawing);
  if (!valid || !Number.isFinite(dt) || !Number.isFinite(dp)) return null;
  if (valid.type === 'horizontal') return cloneDrawing({...valid, anchor: translatePoint(valid.anchor, dt, dp)});
  return cloneDrawing({...valid, start: translatePoint(valid.start, dt, dp), end: translatePoint(valid.end, dt, dp)});
}

export function moveDrawingPoint(drawing, which, point) {
  const valid = cloneDrawing(drawing);
  if (!valid || valid.type !== 'trend' || !validPoint(point) || !['start', 'end'].includes(which)) return null;
  const result = {...valid, [which]: {time: point.time, price: point.price}};
  return result.start.time === result.end.time ? null : result;
}

function svgElement(tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function uid() {
  if (globalThis.crypto?.randomUUID) return `drawing-${crypto.randomUUID()}`;
  return `drawing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Manage session drawings in a dedicated SVG layer. Does not touch chart data,
 * playback state, or price autoscaling. All persisted coordinates are seconds + price.
 */
export function createDrawingTools({chart, series, container, getSession, getBars,
  onChange = () => {}, onStateChange = () => {}, isLocked = () => false, getInterval = () => 60}) {
  if (!chart || !series || !container || typeof getSession !== 'function' || typeof getBars !== 'function') {
    throw new TypeError('createDrawingTools 需要 chart、series、container、getSession 和 getBars。');
  }
  const overlay = svgElement('svg', {class: 'drawing-overlay', 'aria-label': '图表画线层'});
  Object.assign(overlay.style, {position: 'absolute', inset: '0', width: '100%', height: '100%',
    overflow: 'hidden', pointerEvents: 'none', zIndex: '7', touchAction: 'none'});
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.append(overlay);

  let tool = null;
  let selectedId = null;
  let draftStart = null;
  let drag = null;
  let destroyed = false;
  let cachedBars = [];
  let cachedSessionId;
  let cachedDrawingRef;
  let lastStateSignature = '';

  function session() { return getSession(); }
  function currentDrawings() {
    const active = session();
    if (!active) return [];
    if (active.id === cachedSessionId && active.drawings === cachedDrawingRef && Array.isArray(active.drawings)) return active.drawings;
    const original = active.drawings;
    const safe = sanitizeDrawings(original);
    if (JSON.stringify(original ?? []) !== JSON.stringify(safe)) {
      active.drawings = safe;
    } else if (!Array.isArray(active.drawings)) active.drawings = safe;
    cachedSessionId = active.id;
    cachedDrawingRef = active.drawings;
    return active.drawings;
  }
  function replaceDrawing(id, next) {
    const active = session();
    if (!active) return false;
    const list = currentDrawings();
    const index = list.findIndex(item => item.id === id);
    if (index < 0 || !next) return false;
    const safe = cloneDrawing(next);
    if (!safe) return false;
    list[index] = safe;
    onChange();
    return true;
  }
  function addDrawing(drawing) {
    const active = session();
    const safe = cloneDrawing(drawing);
    if (!active || !safe) return false;
    const list = currentDrawings();
    if (list.length >= MAX_DRAWINGS) return false;
    list.push(safe);
    selectedId = safe.id;
    onChange();
    render();
    return true;
  }
  function plotWidth() {
    const ts = chart.timeScale();
    const width = typeof ts.width === 'function' ? ts.width() : container.clientWidth;
    return Number.isFinite(width) ? width : container.clientWidth;
  }
  function priceY(price) {
    const y = series.priceToCoordinate(price);
    return Number.isFinite(y) ? y : null;
  }
  function logicalX(logical) {
    const ts = chart.timeScale();
    const x = ts.logicalToCoordinate(logical);
    if (Number.isFinite(x)) return x;
    const bars = cachedBars;
    if (!bars?.length) return null;
    const maxIndex = Math.max(0, bars.length - 1);
    const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(maxIndex);
    if (Number.isFinite(x0) && Number.isFinite(x1) && maxIndex > 0) return x0 + logical * ((x1 - x0) / maxIndex);
    return null;
  }
  function pointToPixel(point) {
    const logical = timestampToLogical(point.time, cachedBars, getInterval());
    if (logical === null) return null;
    const x = logicalX(logical), y = priceY(point.price);
    return Number.isFinite(x) && Number.isFinite(y) ? {x, y} : null;
  }
  function eventDataPoint(event) {
    const rect = overlay.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > plotWidth() || y > container.clientHeight) return null;
    const ts = chart.timeScale();
    let logical = ts.coordinateToLogical(x);
    if (!Number.isFinite(logical)) {
      const bars = cachedBars;
      if (!bars?.length) return null;
      logical = bars.length - 1 + (x - logicalX(bars.length - 1)) / Math.max(1, logicalX(bars.length - 1) - logicalX(bars.length - 2));
    }
    const price = series.coordinateToPrice(y);
    const time = logicalToTimestamp(logical, cachedBars, getInterval());
    return Number.isSafeInteger(time) && Number.isFinite(price) && price > 0 ? {time, price} : null;
  }
  function createSvg(tag, attrs, className) {
    const node = svgElement(tag, attrs);
    if (className) node.setAttribute('class', className);
    return node;
  }
  function bindHit(node, drawingId, dragKind = 'whole') {
    node.dataset.drawingId = drawingId;
      node.style.pointerEvents = tool ? 'none' : (node.tagName.toLowerCase() === 'circle' ? 'all' : 'stroke');
    node.addEventListener('pointerdown', event => {
      if (isLocked() || tool || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const active = currentDrawings();
      const drawing = active.find(item => item.id === drawingId);
      if (!drawing) return;
      selectedId = drawingId;
      const start = eventDataPoint(event);
      drag = start ? {id: drawingId, kind: dragKind, start, original: cloneDrawing(drawing), list: active, sessionId: session()?.id} : null;
      if (drag) {
        drag.pointerId = event.pointerId;
        try { overlay.setPointerCapture(event.pointerId); } catch {}
      }
      render();
    });
  }
  function renderOne(drawing) {
    if (!cloneDrawing(drawing)) return;
    const chosen = selectedId === drawing.id;
    if (drawing.type === 'horizontal') {
      const y = priceY(drawing.anchor.price);
      if (!Number.isFinite(y)) return;
      const hit = createSvg('line', {x1: 0, x2: plotWidth(), y1: y, y2: y,
        stroke: 'transparent', 'stroke-width': 12, 'vector-effect': 'non-scaling-stroke'}, 'drawing-hit-area');
      bindHit(hit, drawing.id);
      overlay.append(hit);
      const line = createSvg('line', {x1: 0, x2: plotWidth(), y1: y, y2: y,
        stroke: chosen ? '#f3cd73' : '#90a6ab', 'stroke-width': chosen ? 2 : 1.5,
        'stroke-dasharray': chosen ? 'none' : '5 4', 'vector-effect': 'non-scaling-stroke'}, `drawing-line horizontal${chosen ? ' selected' : ''}`);
      line.style.pointerEvents = 'none';
      overlay.append(line);
      return;
    }
    const a = pointToPixel(drawing.start), b = pointToPixel(drawing.end);
    if (!a || !b) return;
    const hit = createSvg('line', {x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: 'transparent', 'stroke-width': 12, 'vector-effect': 'non-scaling-stroke'}, 'drawing-hit-area');
    bindHit(hit, drawing.id);
    overlay.append(hit);
    const line = createSvg('line', {x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: chosen ? '#f3cd73' : '#90a6ab', 'stroke-width': chosen ? 2 : 1.5,
      'stroke-dasharray': chosen ? 'none' : '5 4', 'vector-effect': 'non-scaling-stroke'}, `drawing-line trend${chosen ? ' selected' : ''}`);
    line.style.pointerEvents = 'none';
    overlay.append(line);
    if (chosen) {
      for (const [which, point] of [['start', a], ['end', b]]) {
        const handle = createSvg('circle', {cx: point.x, cy: point.y, r: 5, fill: '#f3cd73', stroke: '#171b1e', 'stroke-width': 2}, 'drawing-handle');
        bindHit(handle, drawing.id, which);
        overlay.append(handle);
      }
    }
  }
  function renderDraft() {
    if (!draftStart) return;
    const a = pointToPixel(draftStart.point);
    if (!a) return;
    if (tool === 'horizontal') {
      const preview = createSvg('line', {x1: 0, x2: plotWidth(), y1: a.y, y2: a.y, stroke: '#7ce0be', 'stroke-width': 1.5, 'stroke-dasharray': '4 3'}, 'drawing-preview');
      preview.style.pointerEvents = 'none';
      overlay.append(preview);
    } else if (tool === 'trendline' && draftStart.current) {
      const b = pointToPixel(draftStart.current);
      if (b) {
        const preview = createSvg('line', {x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#7ce0be', 'stroke-width': 1.5, 'stroke-dasharray': '4 3'}, 'drawing-preview');
        preview.style.pointerEvents = 'none';
        overlay.append(preview);
      }
    }
  }
  function render() {
    if (destroyed) return;
    const active = session();
    const nextSessionId = active?.id ?? null;
    if (cachedSessionId !== undefined && nextSessionId !== cachedSessionId) {
      if (drag) {
        const oldIndex = drag.list.findIndex(item => item.id === drag.id);
        if (oldIndex >= 0) drag.list[oldIndex] = drag.original;
      }
      tool = null; draftStart = null; drag = null; selectedId = null;
      cachedDrawingRef = undefined;
    }
    const width = Math.max(0, plotWidth()), height = Math.max(0, container.clientHeight);
    overlay.style.width = `${width}px`;
    overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
    overlay.replaceChildren();
    const drawings = currentDrawings();
    if (selectedId && !drawings.some(drawing => drawing.id === selectedId)) selectedId = null;
    for (const drawing of drawings) renderOne(drawing);
    renderDraft();
    overlay.style.pointerEvents = isLocked() ? 'none' : (tool ? 'auto' : 'none');
    overlay.style.zIndex = tool && !isLocked() ? '9' : '7';
    const state = {tool, selectedId, drawingCount: drawings.length};
    const signature = JSON.stringify(state);
    if (signature !== lastStateSignature) {
      lastStateSignature = signature;
      onStateChange(state);
    }
  }
  function commitPoint(point) {
    if (!point || isLocked()) return;
    if (tool === 'horizontal') {
      addDrawing({id: uid(), type: 'horizontal', anchor: point});
      return;
    }
    if (tool === 'trendline') {
      if (!draftStart) {
        draftStart = {point};
        render();
      } else {
        const first = draftStart.point;
        if (point.time === first.time) return;
        addDrawing({id: uid(), type: 'trend', start: first, end: point});
        draftStart = null;
        render();
      }
    }
  }
  function pointerDown(event) {
    if (isLocked() || !tool || event.button !== 0 || event.target !== overlay) return;
    const point = eventDataPoint(event);
    if (!point) return;
    event.preventDefault(); event.stopPropagation();
    commitPoint(point);
  }
  function pointerMove(event) {
    if (draftStart && tool === 'trendline') {
      draftStart.current = eventDataPoint(event);
      render();
      return;
    }
    if (!drag || isLocked()) return;
    if (session()?.id !== drag.sessionId) { pointerUp({type: 'pointercancel'}); return; }
    const current = eventDataPoint(event);
    if (!current) return;
    const dt = current.time - drag.start.time, dp = current.price - drag.start.price;
    const drawing = drag.original;
    let next;
    if (drag.kind === 'start' || drag.kind === 'end') next = moveDrawingPoint(drawing, drag.kind, current);
    else next = translateDrawing(drawing, dt, dp);
    if (next) {
      const list = drag.list, index = list.findIndex(item => item.id === drag.id);
      if (index >= 0) list[index] = next;
      render();
    }
  }
  function pointerUp(event) {
    if (drag) {
      if (session()?.id !== drag.sessionId) {
        const index = drag.list.findIndex(item => item.id === drag.id);
        if (index >= 0) drag.list[index] = drag.original;
        drag = null;
        render();
        return;
      }
      if (event?.type === 'pointercancel') {
        const index = drag.list.findIndex(item => item.id === drag.id);
        if (index >= 0) drag.list[index] = drag.original;
        drag = null;
        render();
        return;
      }
      const list = drag.list, changed = list.find(item => item.id === drag.id);
      const changedJson = JSON.stringify(changed), oldJson = JSON.stringify(drag.original);
      drag = null;
      if (changedJson !== oldJson) onChange();
      render();
    }
  }
  function scheduleScaleRefresh() {
    if (typeof requestAnimationFrame !== 'function') { render(); return; }
    requestAnimationFrame(() => requestAnimationFrame(render));
  }
  function keyDown(event) {
    if (event.key === 'Escape' && (tool || draftStart || selectedId)) {
      event.preventDefault(); cancel();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && !isEditable(event.target)) {
      event.preventDefault(); deleteSelected();
    }
  }
  function isEditable(target) {
    return target instanceof Element && (target.matches('input,textarea,select,[contenteditable="true"]') || target.closest('[contenteditable="true"]'));
  }
  function setTool(nextTool) {
    if (![null, 'horizontal', 'trendline'].includes(nextTool)) throw new TypeError('未知画线工具。');
    if (isLocked() && nextTool) return false;
    tool = nextTool;
    draftStart = null;
    if (tool) selectedId = null;
    render();
    return true;
  }
  function deleteSelected() {
    if (!selectedId || isLocked()) return false;
    const active = session();
    if (!active) return false;
    const list = currentDrawings(), index = list.findIndex(item => item.id === selectedId);
    if (index < 0) return false;
    list.splice(index, 1);
    selectedId = null;
    onChange(); render();
    return true;
  }
  function cancel() {
    if (drag) {
      const index = drag.list.findIndex(item => item.id === drag.id);
      if (index >= 0) drag.list[index] = drag.original;
      drag = null;
    }
    tool = null; draftStart = null; selectedId = null; render();
  }
  function refresh(nextBars) {
    const bars = Array.isArray(nextBars) ? nextBars : getBars();
    cachedBars = Array.isArray(bars) ? bars : [];
    render();
  }
  function pointerDownSelect(event) {
    if (tool || event.target !== overlay || isLocked()) return;
    if (selectedId) { selectedId = null; render(); }
  }
  overlay.addEventListener('pointerdown', pointerDown);
  overlay.addEventListener('pointerdown', pointerDownSelect);
  overlay.addEventListener('pointermove', pointerMove);
  overlay.addEventListener('pointerup', pointerUp);
  overlay.addEventListener('pointercancel', pointerUp);
  container.addEventListener('pointerup', scheduleScaleRefresh, true);
  container.addEventListener('pointercancel', scheduleScaleRefresh, true);
  container.addEventListener('wheel', scheduleScaleRefresh, {capture: true, passive: true});
  window.addEventListener('keydown', keyDown);
  const rangeChanged = () => render();
  chart.timeScale().subscribeVisibleLogicalRangeChange(rangeChanged);
  chart.timeScale().subscribeVisibleTimeRangeChange(rangeChanged);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleScaleRefresh) : null;
  resizeObserver?.observe(container);
  refresh();

  return {
    setTool,
    deleteSelected,
    cancel,
    refresh,
    getSelectedId: () => selectedId,
    destroy() {
      destroyed = true;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeChanged);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(rangeChanged);
      resizeObserver?.disconnect();
      window.removeEventListener('keydown', keyDown);
      container.removeEventListener('pointerup', scheduleScaleRefresh, true);
      container.removeEventListener('pointercancel', scheduleScaleRefresh, true);
      container.removeEventListener('wheel', scheduleScaleRefresh, true);
      overlay.remove();
    },
  };
}
