const BUY_COLOR = '#3b82f6';
const SELL_COLOR = '#ef5350';

function finiteTime(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function markerBarTime(executionTime, bars, intervalSeconds) {
  const time = finiteTime(executionTime);
  if (time === null || !Array.isArray(bars) || !bars.length) return null;
  // Fill times are close times. Subtracting one second keeps an execution at an
  // exact timeframe boundary on the candle whose observed price caused it.
  const instant = time - 1;
  if (instant < bars[0].time) return null;
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bars[mid].time <= instant) lo = mid;
    else hi = mid - 1;
  }
  const barTime = bars[lo]?.time;
  return Number.isInteger(barTime) && instant < barTime + Math.max(1, intervalSeconds) ? barTime : null;
}

function factKey(positionId, phase, fallback) {
  return `${positionId || fallback || 'unknown'}|${phase}`;
}

function markerFact({id, positionId, phase, positionSide, price, time, seq}) {
  if (!['entry', 'exit'].includes(phase) || ![1, -1].includes(positionSide) || !Number.isFinite(price) || price <= 0 || finiteTime(time) === null) return null;
  const buy = phase === 'entry' ? positionSide === 1 : positionSide === -1;
  const text = phase === 'entry' ? (positionSide === 1 ? '开多' : '开空') : (positionSide === 1 ? '平多' : '平空');
  return {id: String(id || `${positionId || 'trade'}-${phase}`), positionId: positionId || null, phase,
    positionSide, price, time, seq: Number.isInteger(seq) ? seq : Number.MAX_SAFE_INTEGER,
    buy, text};
}

function collectFacts(session) {
  const facts = [], seen = new Set();
  const add = (raw, fallback) => {
    const fact = markerFact(raw);
    if (!fact) return;
    const key = factKey(fact.positionId, fact.phase, fallback || fact.id);
    if (seen.has(key)) return;
    seen.add(key); facts.push(fact);
  };
  for (const fill of Array.isArray(session?.fills) ? session.fills : []) {
    add({id: fill.id, positionId: fill.positionId, phase: fill.side, positionSide: fill.positionSide,
      price: fill.price, time: fill.time, seq: fill.seq}, fill.id);
  }
  const position = session?.position;
  if (position) add({id: position.entryFillId || `position-${position.positionId || 'open'}-entry`, positionId: position.positionId,
    phase: 'entry', positionSide: position.side, price: position.entry, time: position.entryTime}, position.orderId);
  for (const [index, trade] of (Array.isArray(session?.trades) ? session.trades : []).entries()) {
    const identity = trade.positionId || trade.tradeId || trade.id || `trade-${index + 1}`;
    add({id: trade.entryFillId || `${identity}-entry`, positionId: trade.positionId || identity, phase: 'entry',
      positionSide: trade.side, price: trade.entry, time: trade.entryTime, seq: index * 2 + 1}, identity);
    add({id: trade.exitFillId || `${identity}-exit`, positionId: trade.positionId || identity, phase: 'exit',
      positionSide: trade.side, price: trade.exit, time: trade.exitTime, seq: index * 2 + 2}, identity);
  }
  return facts.sort((a, b) => a.time - b.time || a.seq - b.seq || a.id.localeCompare(b.id));
}

export function buildTradeMarkers(session, bars, intervalSeconds) {
  return collectFacts(session).flatMap(fact => {
    const time = markerBarTime(fact.time, bars, intervalSeconds);
    if (time === null) return [];
    return [{id: fact.id, time, position: fact.buy ? 'belowBar' : 'aboveBar',
      shape: fact.buy ? 'arrowUp' : 'arrowDown', color: fact.buy ? BUY_COLOR : SELL_COLOR,
      text: fact.text, size: .65}];
  });
}

export function buildTradeMarkersThroughStage(session, bars, intervalSeconds, stage) {
  if (!stage || typeof stage !== 'object') return buildTradeMarkers(session, bars, intervalSeconds);
  const fills = Array.isArray(session?.fills) ? session.fills : [];
  const cutoffId = stage.fillId || stage.after?.position?.entryFillId || stage.after?.trade?.exitFillId || null;
  const cutoff = cutoffId ? fills.findIndex(fill => fill?.id === cutoffId) : -1;
  if (cutoff < 0) return buildTradeMarkers(session, bars, intervalSeconds);
  const stageTime = finiteTime(stage.marketTime ?? stage.replayMarketTime ?? stage.visibleThrough);
  const priorTrades = (Array.isArray(session?.trades) ? session.trades : []).filter(trade =>
    stageTime !== null && finiteTime(trade?.entryTime) !== null && finiteTime(trade?.exitTime) !== null && trade.exitTime < stageTime
  );
  return buildTradeMarkers({...session, fills: fills.slice(0, cutoff + 1), position: null, trades: priorTrades}, bars, intervalSeconds);
}

export function tradeMarkerSignature(session, bars, intervalSeconds) {
  const fills = Array.isArray(session?.fills) ? session.fills : [];
  const trades = Array.isArray(session?.trades) ? session.trades : [];
  const lastFill = fills.at(-1), lastTrade = trades.at(-1), position = session?.position;
  return [session?.id || '', intervalSeconds, bars?.[0]?.time ?? '', fills.length, lastFill?.id || '',
    trades.length, lastTrade?.tradeId || lastTrade?.id || '', position?.positionId || '', position?.entryTime ?? ''].join('|');
}
