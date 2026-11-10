import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatKstDate, getKstDate, getKstDateParts, toMinuteOfDay } from '../src/services/kstTime.js';

test('UTC 15:00 이후는 한국 시간으로 다음 날이다', () => {
  assert.equal(getKstDate(new Date('2026-11-10T14:59:00Z')), '2026-11-10');
  assert.equal(getKstDate(new Date('2026-11-10T15:00:00Z')), '2026-11-11');
});

test('getKstDateParts는 KST 기준 시각을 숫자로 돌려준다', () => {
  assert.deepEqual(getKstDateParts(new Date('2026-12-31T15:30:00Z')), {
    year: 2027, month: 1, day: 1, hour: 0, minute: 30,
  });
});

test('formatKstDate는 월/일을 두 자리로 채운다', () => {
  assert.equal(formatKstDate({ year: 2026, month: 3, day: 7 }), '2026-03-07');
});

test('toMinuteOfDay', () => {
  assert.equal(toMinuteOfDay(0, 0), 0);
  assert.equal(toMinuteOfDay(9, 30), 570);
  assert.equal(toMinuteOfDay(23, 59), 1439);
});
