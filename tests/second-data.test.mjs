import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSecond, readSecondRange} from '../dist/second-data.mjs';

const DAY = '2025-01-01';
const START = Date.parse(`${DAY}T00:00:00Z`) / 1000;
const SHA = 'a'.repeat(64);

function payload(day = DAY, {missingAt = -1} = {}) {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000;
  const candles = [];
  for (let index = 0; index < 86_400; index += 1) {
    if (index === missingAt) continue;
    candles.push([start + index, 100 + index % 3, 101 + index % 3, 99 + index % 3, 100 + index % 3, 0.25]);
  }
  return {symbol: 'BTCUSDT', date: day, interval: 1, candles,
    source: {url: `https://data.binance.vision/${day}.zip`, checksum_url: `https://data.binance.vision/${day}.zip.CHECKSUM`, sha256: SHA}};
}

test('range returns only complete second rows within an exclusive close cutoff and includes source hashes', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return {ok: true, json: async () => payload()}; };
  const from = START + 10, through = START + 15;
  const range = await readSecondRange('BTCUSDT', from, through);
  assert.deepEqual(range.candles.map(row => row[0]), [START + 10, START + 11, START + 12, START + 13, START + 14]);
  assert.equal(range.days[0].archiveSha256, SHA);
  assert.equal(range.candles.at(-1)[0] + 1, through);
  assert.equal(calls, 1);
});

test('nextSecond is strictly after its cursor and shares the verified day cache', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return {ok: true, json: async () => payload()}; };
  const next = await nextSecond('BTCUSDT', START + 20);
  assert.equal(next[0], START + 21);
  assert.equal(calls, 0); // the previous range already warmed this shared day cache
});

test('a missing second invalidates the source day instead of silently padding or skipping', async () => {
  globalThis.fetch = async () => ({ok: true, json: async () => payload('2025-01-02', {missingAt: 2})});
  const start = Date.parse('2025-01-02T00:00:00Z') / 1000;
  const range = await readSecondRange('BTCUSDT', start, start + 4);
  assert.equal(range.candles.length, 0);
  assert.equal(range.stoppedAt, '2025-01-02');
  assert.match(range.unavailable[0].reason, /格式不完整/);
});

test('a missing archive stops the range and never advances to a later UTC day', async () => {
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(url);
    return {ok: false, status: 404, json: async () => ({error: 'archive missing'})};
  };
  const start = Date.parse('2025-01-03T23:59:59Z') / 1000;
  const result = await readSecondRange('BTCUSDT', start, start + 2);
  assert.equal(result.stoppedAt, '2025-01-03');
  assert.equal(result.unavailable.length, 1);
  assert.equal(requested.length, 1);
});
