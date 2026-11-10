import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceTeams } from '../src/services/teamBalancer.js';

const toPlayers = (scores) => scores.map((powerScore, index) => ({ name: `P${index}`, powerScore }));
const spread = (scores) => Math.max(...scores) - Math.min(...scores);

// Exhaustive reference: every assignment that respects the balancer's target team sizes.
function bruteForceSpread(scores, teamCount) {
  const baseSize = Math.floor(scores.length / teamCount);
  const extraTeams = scores.length % teamCount;
  const targetSizes = Array.from({ length: teamCount }, (_, index) => baseSize + (index < extraTeams ? 1 : 0));
  let best = Infinity;
  const sizes = Array(teamCount).fill(0);
  const sums = Array(teamCount).fill(0);
  (function assign(index) {
    if (index === scores.length) {
      best = Math.min(best, spread(sums));
      return;
    }
    for (let team = 0; team < teamCount; team++) {
      if (sizes[team] >= targetSizes[team]) continue;
      sizes[team] += 1;
      sums[team] += scores[index];
      assign(index + 1);
      sizes[team] -= 1;
      sums[team] -= scores[index];
    }
  })(0);
  return best;
}

test('3팀 2/1/1 분할에서 최적해를 찾는다 (회귀)', () => {
  const result = balanceTeams(toPlayers([10, 6, 4, 1]), 3);
  assert.equal(spread(result.teamScores), 5);
});

test('홀수 인원 2팀 분할에서 최적해를 찾는다', () => {
  const scores = [100, 1, 1, 1, 1];
  const result = balanceTeams(toPlayers(scores), 2);
  assert.equal(spread(result.teamScores), bruteForceSpread(scores, 2));
  assert.deepEqual(result.teams.map((team) => team.length).sort(), [2, 3]);
});

test('모든 플레이어가 정확히 한 팀에 배정되고 인원 차이는 1 이하', () => {
  const players = toPlayers([50, 40, 30, 20, 10, 5, 3]);
  const { teams } = balanceTeams(players, 3);
  const assigned = teams.flat();
  assert.equal(assigned.length, players.length);
  assert.equal(new Set(assigned).size, players.length);
  const sizes = teams.map((team) => team.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});

test('작은 무작위 입력에서 완전 탐색과 같은 편차를 낸다', () => {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let round = 0; round < 200; round++) {
    const teamCount = random() < 0.5 ? 2 : 3;
    const count = teamCount + Math.floor(random() * (9 - teamCount));
    const scores = Array.from({ length: count }, () => Math.round(random() * 300));
    const result = balanceTeams(toPlayers(scores), teamCount);
    assert.equal(spread(result.teamScores), bruteForceSpread(scores, teamCount), `scores=${scores} teams=${teamCount}`);
  }
});

test('잘못된 입력은 오류를 던진다', () => {
  assert.throws(() => balanceTeams(toPlayers([1, 2]), 4));
  assert.throws(() => balanceTeams(toPlayers([1, 2]), 3));
  assert.throws(() => balanceTeams(toPlayers(Array(16).fill(1)), 2));
});
