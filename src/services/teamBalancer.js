/**
 * Split players into balanced teams by total power score.
 * Supports 2 or 3 teams, up to 15 players. Team sizes differ by at most 1.
 * @param {{id?:string, name:string, tag?:string, powerScore:number}[]} players
 * @param {2|3} teamCount
 */
export function balanceTeams(players, teamCount = 2) {
  const count = players.length;
  if (![2, 3].includes(teamCount)) throw new Error('팀 수는 2팀 또는 3팀만 가능합니다.');
  if (count < teamCount) throw new Error(`${teamCount}팀으로 나누려면 최소 ${teamCount}명이 필요합니다.`);
  if (count > 15) throw new Error('최대 15명까지만 매칭할 수 있습니다.');

  const baseSize = Math.floor(count / teamCount);
  const extraTeams = count % teamCount;
  const targetSizes = Array.from({ length: teamCount }, (_, index) => baseSize + (index < extraTeams ? 1 : 0));
  const totalScore = players.reduce((sum, player) => sum + Number(player.powerScore ?? 0), 0);
  const targetAverage = totalScore / teamCount;

  const teams = Array.from({ length: teamCount }, () => []);
  const teamScores = Array.from({ length: teamCount }, () => 0);
  let best = null;

  function scoreSpread(scores) {
    return Math.max(...scores) - Math.min(...scores);
  }

  function scoreDeviation(scores) {
    return scores.reduce((sum, score) => sum + Math.abs(score - targetAverage), 0);
  }

  function search(playerIndex) {
    if (playerIndex === count) {
      const spread = scoreSpread(teamScores);
      const deviation = scoreDeviation(teamScores);
      if (!best || spread < best.spread || (spread === best.spread && deviation < best.deviation)) {
        best = {
          spread,
          deviation,
          teams: teams.map((team) => [...team]),
          teamScores: [...teamScores],
        };
      }
      return;
    }

    const player = players[playerIndex];
    for (let teamIndex = 0; teamIndex < teamCount; teamIndex++) {
      if (teams[teamIndex].length >= targetSizes[teamIndex]) continue;

      teams[teamIndex].push(player);
      teamScores[teamIndex] += Number(player.powerScore ?? 0);
      search(playerIndex + 1);
      teamScores[teamIndex] -= Number(player.powerScore ?? 0);
      teams[teamIndex].pop();

      if (teams[teamIndex].length === 0) break;
    }
  }

  search(0);

  return {
    teams: best.teams,
    teamScores: best.teamScores,
    teamA: best.teams[0],
    teamB: best.teams[1],
    teamAScore: best.teamScores[0],
    teamBScore: best.teamScores[1],
  };
}
