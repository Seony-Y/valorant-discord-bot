import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePowerScore, tierToScore } from '../src/services/scoring.js';

test('tierToScore는 랭크를 1~25로 변환하고 대소문자를 무시한다', () => {
  assert.equal(tierToScore('Iron 1'), 1);
  assert.equal(tierToScore('gold 2'), 11);
  assert.equal(tierToScore('Radiant'), 25);
});

test('tierToScore는 언랭크/알 수 없는 값을 0으로 처리한다', () => {
  assert.equal(tierToScore(null), 0);
  assert.equal(tierToScore(''), 0);
  assert.equal(tierToScore('Unrated'), 0);
});

test('티어가 없으면 ACS 50% + KDA*50', () => {
  assert.equal(computePowerScore({ kda: 1.2, acs: 200 }), 200 * 0.5 + 1.2 * 50);
});

test('티어가 있으면 ACS 40% + KDA*50 + 티어(현재 70%, 최고 30%)', () => {
  const expected = 200 * 0.4 + 1.2 * 50 + tierToScore('Gold 2') * 0.7 + tierToScore('Diamond 1') * 0.3;
  assert.equal(computePowerScore({ kda: 1.2, acs: 200, currentTier: 'Gold 2', peakTier: 'Diamond 1' }), expected);
});

test('누락된 지표는 0으로 계산한다', () => {
  assert.equal(computePowerScore({}), 0);
});
