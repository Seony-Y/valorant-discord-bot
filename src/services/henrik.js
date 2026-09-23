import axios from 'axios';

const BASE_URL = 'https://api.henrikdev.xyz';

const client = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: process.env.HENRIK_API_KEY },
  timeout: 10_000,
});

let actsCache;
let actsCachePromise;
let valorantContentCache;
let valorantContentCachedAt = 0;
let valorantContentCachePromise;
const seasonMatchesCache = new Map();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const SEASON_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTENT_CACHE_TTL_MS = 15 * 60 * 1000;

export async function getValorantContent() {
  if (valorantContentCache && Date.now() - valorantContentCachedAt < CONTENT_CACHE_TTL_MS) {
    return valorantContentCache;
  }
  if (valorantContentCachePromise) return valorantContentCachePromise;

  valorantContentCachePromise = client.get('/valorant/v1/content', { params: { locale: 'ko-KR' } })
    .then(({ data }) => {
      valorantContentCache = data.data;
      valorantContentCachedAt = Date.now();
      return valorantContentCache;
    })
    .finally(() => {
      valorantContentCachePromise = undefined;
    });
  return valorantContentCachePromise;
}

/** Resolve a Riot ID (name#tag) to puuid + region-aware account info. */
export async function getAccount(name, tag) {
  const { data } = await client.get(`/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  return data.data;
}

/** Current + peak competitive tier. */
export async function getMMR(region, name, tag) {
  let data;
  try {
    ({ data } = await client.get(`/valorant/v2/mmr/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`));
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error(`Riot 계정을 찾을 수 없습니다. 이름/태그/지역을 확인해주세요: ${name}#${tag} (${region})`);
    }
    throw error;
  }
  const current = data.data;

  let historyRes;
  try {
    ({ data: historyRes } = await client.get(
      `/valorant/v1/mmr-history/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`
    ));
  } catch (error) {
    if (error.response?.status === 404) {
      historyRes = { data: [] };
    } else {
      throw error;
    }
  }
  const history = historyRes.data ?? [];
  const peak = history.reduce((best, entry) => {
    const rank = entry.currenttierpatched;
    return best === null || (entry.elo ?? 0) > best.elo ? { rank, elo: entry.elo ?? 0 } : best;
  }, null);

  return {
    currentTier: current.current_data?.currenttierpatched ?? current.currenttierpatched,
    currentElo: current.current_data?.elo ?? current.elo,
    peakTier: current.highest_rank?.patched_tier ?? peak?.rank ?? current.current_data?.currenttierpatched ?? current.currenttierpatched,
  };
}

async function getMatches(region, name, tag, size) {
  try {
    const { data } = await client.get(
      `/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      { params: { size } }
    );
    return data.data ?? [];
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error(`최근 매치 기록을 찾을 수 없습니다. Riot ID 또는 지역을 확인해주세요: ${name}#${tag} (${region})`);
    }
    throw error;
  }
}

async function getV4Matches(region, name, tag, start) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { data } = await client.get(
        `/valorant/v4/matches/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        { params: { size: 10, start }, timeout: 20_000 }
      );
      return data.data ?? [];
    } catch (error) {
      const isRateLimited = error.response?.status === 429;
      const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
      if ((!isRateLimited && !isTimeout) || attempt === 4) throw error;
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 5_000 * (attempt + 1));
    }
  }
}

export async function getValorantActs() {
  if (actsCache) return actsCache;
  if (actsCachePromise) return actsCachePromise;

  actsCachePromise = getValorantContent()
    .then((content) => {
      const acts = content?.acts ?? [];
      const episodesById = new Map(
        acts.filter((act) => act.type === 'episode').map((episode) => [episode.id, episode.name])
      );
      actsCache = acts
        .filter((act) => act.type === 'act' && act.id && act.name)
        .map((act, order) => ({
          id: act.id,
          name: `${episodesById.get(act.parentId) ?? '에피소드'} · ${act.name}`,
          order,
        }));
      return actsCache;
    })
    .finally(() => {
      actsCachePromise = undefined;
    });
  return actsCachePromise;
}

export async function getSeasonMatchDetails(region, name, tag, seasonId) {
  const cacheKey = `${region}:${name.toLowerCase()}:${tag.toLowerCase()}:${seasonId}`;
  const cached = seasonMatchesCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < SEASON_CACHE_TTL_MS) return cached.matchDetails;

  const matchDetails = [];
  const acts = await getValorantActs();
  const seasonOrder = new Map(acts.map((act) => [act.id, act.order]));
  const requestedSeasonOrder = seasonOrder.get(seasonId);
  let foundSeason = false;

  for (let start = 0; start < 100; start += 10) {
    const matches = await getV4Matches(region, name, tag, start);
    const pageHasSeason = matches.some((match) => match.metadata?.season?.id === seasonId);
    if (foundSeason && !pageHasSeason) break;
    if (
      !pageHasSeason &&
      Number.isInteger(requestedSeasonOrder) &&
      matches.some((match) => seasonOrder.get(match.metadata?.season?.id) > requestedSeasonOrder)
    ) {
      break;
    }

    for (const match of matches) {
      if (
        match.metadata?.season?.id !== seasonId ||
        !['competitive', 'unrated'].includes(match.metadata?.queue?.name?.toLowerCase())
      ) {
        continue;
      }

      const player = match.players?.find((entry) => entry.name === name && entry.tag === tag);
      if (!player) continue;

      const team = match.teams?.find((entry) => entry.team_id === player.team_id);
      const roundsPlayed = (team?.rounds?.won ?? 0) + (team?.rounds?.lost ?? 0);
      matchDetails.push({
        map: match.metadata?.map?.name ?? 'Unknown',
        result: team?.won ? '승' : '패',
        agent: player.agent?.name ?? 'Unknown',
        kills: player.stats?.kills ?? 0,
        deaths: player.stats?.deaths ?? 0,
        assists: player.stats?.assists ?? 0,
        acs: roundsPlayed ? Math.round((player.stats?.score ?? 0) / roundsPlayed) : 0,
        damagePerRound: roundsPlayed
          ? Number(((player.stats?.damage?.dealt ?? 0) / roundsPlayed).toFixed(1))
          : 0,
        startedAt: Date.parse(match.metadata?.started_at) || 0,
      });
    }
    foundSeason ||= pageHasSeason;
    if (matches.length < 10) break;
  }

  seasonMatchesCache.set(cacheKey, { matchDetails, updatedAt: Date.now() });
  return matchDetails;
}

/** Pull only the fields needed for team balancing: KDA + ACS. */
export async function getPowerMatchSummary(region, name, tag, size = 20) {
  const matches = await getMatches(region, name, tag, size);

  let kills = 0, deaths = 0, assists = 0, totalScore = 0, totalRounds = 0, gamesConsidered = 0;
  for (const match of matches) {
    const me = match.players?.all_players?.find((p) => p.name === name && p.tag === tag);
    if (!me) continue;

    kills += me.stats?.kills ?? 0;
    deaths += me.stats?.deaths ?? 0;
    assists += me.stats?.assists ?? 0;
    totalScore += me.stats?.score ?? 0;
    totalRounds += match.metadata?.rounds_played ?? match.rounds?.length ?? 0;
    gamesConsidered += 1;
  }

  const kda = deaths === 0 ? kills + assists : (kills + assists) / deaths;
  return {
    kda: Number(kda.toFixed(2)),
    acs: totalRounds ? Math.round(totalScore / totalRounds) : 0,
    gamesConsidered,
  };
}

/** Pull the last 10 competitive or unrated matches and derive match statistics. */
function normalizeAbilityCasts(abilityCasts = {}) {
  const normalized = { q: 0, c: 0, e: 0, x: 0 };
  for (const [key, value] of Object.entries(abilityCasts)) {
    const numericValue = Number(value) || 0;
    const lowerKey = String(key).toLowerCase();
    if (lowerKey.includes('q')) normalized.q += numericValue;
    else if (lowerKey.includes('c')) normalized.c += numericValue;
    else if (lowerKey.includes('e')) normalized.e += numericValue;
    else if (lowerKey.includes('x') || lowerKey.includes('ult')) normalized.x += numericValue;
  }
  return normalized;
}

export async function getMatchSummary(region, name, tag, size = 20, seasonId, matchLimit = 10) {
  const matches = (await getMatches(region, name, tag, size))
    .filter((match) => ['competitive', 'unrated'].includes(match.metadata?.mode?.toLowerCase()))
    .filter((match) => !seasonId || match.metadata?.season_id === seasonId)
    .slice(0, matchLimit);

  let kills = 0, deaths = 0, assists = 0;
  let wins = 0;
  let totalScore = 0;
  let totalDamage = 0;
  let totalDamageReceived = 0;
  let totalRounds = 0;
  let headshots = 0;
  let bodyshots = 0;
  let legshots = 0;
  const agentStats = new Map(); // agent -> { games, wins }
  const mapStats = new Map(); // map -> { games, wins }
  const weaponStats = new Map(); // weapon -> { kills, games, wins }
  const matchDetails = [];
  const totalSkillUsage = { q: 0, c: 0, e: 0, x: 0 };

  for (const match of matches) {
    const me = match.players?.all_players?.find((p) => p.name === name && p.tag === tag);
    if (!me) continue;

    const myTeamId = me.team_id ?? me.team;
    const won = match.teams?.[myTeamId?.toLowerCase?.() ?? myTeamId]?.has_won ?? false;
    const roundsPlayed = match.metadata?.rounds_played ?? match.rounds?.length ?? 0;
    const abilityCasts = normalizeAbilityCasts(me.ability_casts ?? {});

    kills += me.stats?.kills ?? 0;
    deaths += me.stats?.deaths ?? 0;
    assists += me.stats?.assists ?? 0;
    if (won) wins += 1;
    totalScore += me.stats?.score ?? 0;
    totalDamage += me.damage_made ?? 0;
    totalDamageReceived += me.damage_received ?? 0;
    totalRounds += roundsPlayed;
    headshots += me.stats?.headshots ?? 0;
    bodyshots += me.stats?.bodyshots ?? 0;
    legshots += me.stats?.legshots ?? 0;

    matchDetails.push({
      map: match.metadata?.map ?? 'Unknown',
      result: won ? '승' : '패',
      agent: me.character ?? 'Unknown',
      kills: me.stats?.kills ?? 0,
      deaths: me.stats?.deaths ?? 0,
      assists: me.stats?.assists ?? 0,
      acs: roundsPlayed ? Math.round((me.stats?.score ?? 0) / roundsPlayed) : 0,
      damagePerRound: roundsPlayed ? Number(((me.damage_made ?? 0) / roundsPlayed).toFixed(1)) : 0,
      abilityCasts,
      rounds: roundsPlayed,
      startedAt: match.metadata?.game_start ?? 0,
    });

    totalSkillUsage.q += abilityCasts.q;
    totalSkillUsage.c += abilityCasts.c;
    totalSkillUsage.e += abilityCasts.e;
    totalSkillUsage.x += abilityCasts.x;

    const agent = me.character;
    const agentEntry = agentStats.get(agent) ?? { games: 0, wins: 0 };
    agentEntry.games += 1;
    if (won) agentEntry.wins += 1;
    agentStats.set(agent, agentEntry);

    const map = match.metadata?.map;
    const mapEntry = mapStats.get(map) ?? { games: 0, wins: 0 };
    mapEntry.games += 1;
    if (won) mapEntry.wins += 1;
    mapStats.set(map, mapEntry);

    const weaponsUsed = new Set();
    for (const kill of match.kills ?? []) {
      if (kill.killer_puuid !== me.puuid || !kill.damage_weapon_name) continue;

      const weapon = kill.damage_weapon_name;
      const weaponEntry = weaponStats.get(weapon) ?? { kills: 0, games: 0, wins: 0 };
      weaponEntry.kills += 1;
      weaponStats.set(weapon, weaponEntry);
      weaponsUsed.add(weapon);
    }

    for (const weapon of weaponsUsed) {
      const weaponEntry = weaponStats.get(weapon);
      weaponEntry.games += 1;
      if (won) weaponEntry.wins += 1;
    }
  }

  const kda = deaths === 0 ? kills + assists : (kills + assists) / deaths;

  const topAgents = [...agentStats.entries()]
    .sort((a, b) => b[1].games - a[1].games)
    .slice(0, 5)
    .map(([agent, s]) => ({
      agent,
      games: s.games,
      playRate: matches.length ? Math.round((s.games / matches.length) * 100) : 0,
      winRate: Math.round((s.wins / s.games) * 100),
    }));

  const mapWinrates = Object.fromEntries(
    [...mapStats.entries()].map(([map, s]) => [map, Math.round((s.wins / s.games) * 100)])
  );
  const mapGames = Object.fromEntries([...mapStats.entries()].map(([map, s]) => [map, s.games]));
  const mapWins = Object.fromEntries([...mapStats.entries()].map(([map, s]) => [map, s.wins]));
  const weapons = [...weaponStats.entries()]
    .sort((a, b) => b[1].kills - a[1].kills)
    .slice(0, 5)
    .map(([weapon, s]) => ({
      weapon,
      kills: s.kills,
      killRate: kills ? Math.round((s.kills / kills) * 100) : 0,
    }));

  return {
    kda: Number(kda.toFixed(2)),
    kd: Number((deaths === 0 ? kills : kills / deaths).toFixed(2)),
    winRate: matches.length ? Math.round((wins / matches.length) * 100) : 0,
    acs: totalRounds ? Math.round(totalScore / totalRounds) : 0,
    damagePerRound: totalRounds ? Number((totalDamage / totalRounds).toFixed(1)) : 0,
    damageDeltaPerRound: totalRounds
      ? Number(((totalDamage - totalDamageReceived) / totalRounds).toFixed(1))
      : 0,
    headshotRate:
      headshots + bodyshots + legshots
        ? Number(((headshots / (headshots + bodyshots + legshots)) * 100).toFixed(1))
        : 0,
    bodyshotRate:
      headshots + bodyshots + legshots
        ? Number(((bodyshots / (headshots + bodyshots + legshots)) * 100).toFixed(1))
        : 0,
    legshotRate:
      headshots + bodyshots + legshots
        ? Number(((legshots / (headshots + bodyshots + legshots)) * 100).toFixed(1))
        : 0,
    topAgents,
    weapons,
    mapWinrates,
    mapGames,
    mapWins,
    abilityUsage: totalSkillUsage,
    matchDetails,
    gamesConsidered: matches.length,
  };
}
