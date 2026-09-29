import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {aggregateDisclosedSeconds} from '../dist/engine.mjs';

const source = readFileSync(new URL('../dist/app.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function rememberDisclosedSecond(');
const end = source.indexOf('\nfunction minuteRangeCovered(', start);
assert.ok(start >= 0 && end > start, 'second disclosure cache helper should remain identifiable');

function cacheHarness() {
  const secondRowsBySymbol = new Map(), secondBarsBySymbol = new Map(), secondCoverageBySymbol = new Map();
  const sandbox = {secondRowsBySymbol, secondBarsBySymbol, secondCoverageBySymbol, SECOND_CACHE_MAX_ROWS: 750_000,
    intervalStart: (time, interval) => Math.floor(time / interval) * interval,
    aggregateDisclosedSeconds};
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.remember=rememberDisclosedSecond;`, sandbox);
  return {remember: sandbox.remember, secondRowsBySymbol};
}

for (const count of [288_000, 720_000]) {
  test(`out-of-order second disclosure updates a ${count.toLocaleString()}-row cache without argument overflow`, () => {
    const {remember, secondRowsBySymbol} = cacheHarness();
    const first = 1_735_689_600;
    const rows = Array.from({length: count}, (_, index) => [first + index, 100, 101, 99, 100, 1]);
    secondRowsBySymbol.set('BTCUSDT', rows);

    assert.doesNotThrow(() => remember('BTCUSDT', [first + 1, 101, 102, 100, 101, 2]));
    const updated = secondRowsBySymbol.get('BTCUSDT');
    assert.equal(updated.length, count);
    assert.deepEqual(updated[1], [first + 1, 101, 102, 100, 101, 2]);
    assert.equal(updated.at(-1)[0], first + count - 1);

    const throughExclusive = first + 120;
    const visible = aggregateDisclosedSeconds(updated, 120, throughExclusive, 0);
    assert.ok(visible.every(bar => bar.time + 120 <= throughExclusive), 'cached future rows stay beyond the frozen replay cutoff');
    assert.equal(visible.at(-1).time, first);
  });
}
