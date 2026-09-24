import test from 'node:test';
import assert from 'node:assert/strict';
import {nextMinute} from '../dist/minute-data.mjs';

function response(payload, status=200) {
  return {ok:status>=200&&status<300,status,json:async()=>payload};
}
function dayPayload(symbol,date,times) {
  return {symbol,date,interval:60,candles:times.map(time=>[time,100,101,99,100.5,2]),source:{sha256:'a'.repeat(64)}};
}

test('returns the first strictly later verified minute', async () => {
  const original=globalThis.fetch;const time=Date.UTC(2025,3,2)/1000;
  globalThis.fetch=async url=>{assert.match(url,/BTCUSDT\/2025-04-02$/);return response(dayPayload('BTCUSDT','2025-04-02',[time,time+60,time+120]));};
  try {
    assert.deepEqual(await nextMinute('BTCUSDT',time-1),[time,100,101,99,100.5,2]);
    assert.deepEqual(await nextMinute('BTCUSDT',time),[time+60,100,101,99,100.5,2]);
  } finally {globalThis.fetch=original;}
});

test('does not skip an unavailable archive day that may contain candles', async () => {
  const original=globalThis.fetch;const day1='2025-05-08';const day2='2025-05-09';const next=Date.UTC(2025,4,9)/1000;
  const afterTime=Date.UTC(2025,4,8,12)/1000;
  const urls=[];
  globalThis.fetch=async url=>{urls.push(url);return url.endsWith(day1)?response({error:'该 UTC 日没有可用的 Binance 分钟归档。'},404):response(dayPayload('ETHUSDT',day2,[next,next+60]));};
  try {
    await assert.rejects(nextMinute('ETHUSDT',afterTime),/没有可用的 Binance 分钟归档/);
    assert.equal(urls.length,1);
    assert.match(urls[0],new RegExp(day1+'$'));
  } finally {globalThis.fetch=original;}
});

test('crosses UTC midnight only after a valid cached day has no later rows', async () => {
  const original=globalThis.fetch;const day1='2025-05-10';const day2='2025-05-11';const next=Date.UTC(2025,4,11)/1000;
  const afterTime=Date.UTC(2025,4,10,12)/1000;const urls=[];
  globalThis.fetch=async url=>{
    urls.push(url);
    return url.endsWith(day1)
      ? response(dayPayload('ETHUSDT',day1,[Date.UTC(2025,4,10)/1000]))
      : response(dayPayload('ETHUSDT',day2,[next]));
  };
  try {
    assert.deepEqual(await nextMinute('ETHUSDT',afterTime),[next,100,101,99,100.5,2]);
    assert.equal(urls.length,2);
  } finally {globalThis.fetch=original;}
});

test('does not fall back when the local data API fails', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async()=>response({error:'SHA256校验失败'},502);
  try {
    await assert.rejects(nextMinute('BTCUSDT',Date.UTC(2025,6,2)/1000),/SHA256校验失败/);
  } finally {globalThis.fetch=original;}
});

test('rejects unsupported symbols and out-of-range dates before network access', async () => {
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls+=1;return response({});};
  try {
    await assert.rejects(nextMinute('LTCUSDT',Date.UTC(2025,7,1)/1000),/只支持 BTCUSDT 和 ETHUSDT/);
    await assert.rejects(nextMinute('BTCUSDT',Date.UTC(2026,0,1)/1000),/超出 2022–2025/);
    assert.equal(calls,0);
  } finally {globalThis.fetch=original;}
});

test('deduplicates overlapping requests for the same UTC day', async () => {
  const original=globalThis.fetch;const time=Date.UTC(2025,8,3)/1000;let calls=0;
  globalThis.fetch=async()=>{calls+=1;await new Promise(resolve=>setTimeout(resolve,10));return response(dayPayload('ETHUSDT','2025-09-03',[time,time+60]));};
  try {
    const [a,b]=await Promise.all([nextMinute('ETHUSDT',time-1),nextMinute('ETHUSDT',time)]);
    assert.equal(calls,1);assert.equal(a[0],time);assert.equal(b[0],time+60);
  } finally {globalThis.fetch=original;}
});
