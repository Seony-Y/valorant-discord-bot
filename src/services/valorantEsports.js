import axios from 'axios';
import { load } from 'cheerio';

const GRAPHQL_URL = 'https://valorantesports.com/api/gql';
const SITE_URL = 'https://valorantesports.com';
const HOME_EVENTS_HASH = '7246add6f577cf30b304e651bf9e25fc6a41fe49aeafb0754c16b5778060fc0a';
const SEASON_NAVIGATION_HASH = '648eb6b8cb2f354748640315e16aadd1afacf78e47ca5507c1160cfa44d5d42f';
const SEASON_IDS = new Map([[2026, '115571062868511862']]);
const CACHE_TTL_MS = 5 * 60 * 1000;
const TIER_ONE_LEAGUES = new Set(['vct_americas', 'vct_emea', 'vct_pacific', 'vct_cn', 'valorant_masters', 'valorant_champions']);
const cache = new Map();

const client = axios.create({
  timeout: 15_000,
  headers: {
    Accept: 'application/graphql-response+json,application/json;q=0.9',
    'Content-Type': 'application/json',
    'apollographql-client-name': 'Esports Web',
    'apollographql-client-version': '3520edd',
    Referer: 'https://valorantesports.com/ko-KR',
  },
});

function getCached(key) {
  const cached = cache.get(key);
  return cached && Date.now() - cached.updatedAt < CACHE_TTL_MS ? cached.value : null;
}

function setCached(key, value) {
  cache.set(key, { value, updatedAt: Date.now() });
  return value;
}

function koreanYearRange(year) {
  return {
    eventDateStart: `${year}-01-01T00:00:00.000Z`,
    eventDateEnd: `${year}-12-31T23:59:59.999Z`,
  };
}

function isTierOneLeague(league) {
  const slug = league?.slug?.toLowerCase();
  if (TIER_ONE_LEAGUES.has(slug)) return true;
  return /VCT|마스터스|챔피언스/i.test(league?.name ?? '');
}

export function translateEventState(state) {
  return ({
    completed: '종료',
    inProgress: '진행 중',
    inprogress: '진행 중',
    unstarted: '예정',
  })[state] ?? '상태 미정';
}

export function formatKoreanDateTime(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

export async function fetchTierOneEvents(year = new Date().getFullYear(), leagueSlug) {
  const cacheKey = `events:${year}:${leagueSlug ?? 'all'}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const extensions = {
    clientLibrary: { name: '@apollo/client', version: '4.1.2' },
    persistedQuery: { version: 1, sha256Hash: HOME_EVENTS_HASH },
  };
  const responses = await Promise.all(['completed', 'unstarted', 'inProgress'].map(async (eventState) => {
    const variables = {
      hl: 'ko-KR',
      sport: 'val',
      ...koreanYearRange(year),
      eventState: [eventState],
      eventType: 'all',
      vodType: ['recap'],
      pageSize: 300,
    };
    const { data } = await client.get(GRAPHQL_URL, {
      params: { operationName: 'homeEvents', variables: JSON.stringify(variables), extensions: JSON.stringify(extensions) },
    });
    if (data.errors?.length) throw new Error(data.errors[0].message);
    return data.data?.esports?.events ?? [];
  }));

  const eventsById = new Map(responses.flat().map((event) => [event.id, event]));
  const events = [...eventsById.values()]
    .filter((event) => isTierOneLeague(event.league))
    .filter((event) => !leagueSlug || event.league?.slug === leagueSlug)
    .sort((left, right) => new Date(left.startTime) - new Date(right.startTime));
  return setCached(cacheKey, events);
}

export async function getTournamentChoices(year = new Date().getFullYear()) {
  const seasonId = SEASON_IDS.get(year);
  if (seasonId) {
    const cacheKey = `tournaments:${year}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const variables = { hl: 'ko-KR', seasonId };
    const extensions = {
      clientLibrary: { name: '@apollo/client', version: '4.1.2' },
      persistedQuery: { version: 1, sha256Hash: SEASON_NAVIGATION_HASH },
    };
    const { data } = await client.get(GRAPHQL_URL, {
      params: {
        operationName: 'GetSeasonForNavigation',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify(extensions),
      },
    });
    if (data.errors?.length) throw new Error(data.errors[0].message);
    const tournaments = (data.data?.seasons?.[0]?.splits ?? [])
      .flatMap((split) => split.tournaments ?? [])
      .map((tournament) => ({
        id: tournament.id,
        name: tournament.name,
        leagueName: tournament.league?.name ?? '공식 대회',
        startTime: tournament.startTime,
        endTime: tournament.endTime,
      }))
      .sort((left, right) => new Date(right.startTime) - new Date(left.startTime));
    return setCached(cacheKey, tournaments);
  }

  const events = await fetchTierOneEvents(year);
  const tournaments = new Map();
  for (const event of events) {
    if (!event.tournament?.id) continue;
    tournaments.set(event.tournament.id, {
      id: event.tournament.id,
      name: event.tournament.name,
      leagueName: event.league?.name ?? '공식 대회',
      startTime: event.startTime,
    });
  }
  return [...tournaments.values()].sort((left, right) => new Date(right.startTime) - new Date(left.startTime));
}

export async function getLatestTournamentChoice(year = new Date().getFullYear(), now = new Date()) {
  const tournaments = await getTournamentChoices(year);
  return tournaments
    .filter((tournament) => new Date(tournament.startTime) <= now)
    .sort((left, right) =>
      new Date(right.endTime ?? right.startTime) - new Date(left.endTime ?? left.startTime)
    )[0] ?? null;
}

export async function fetchTournamentStages(tournamentId) {
  const cacheKey = `stages:${tournamentId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `${SITE_URL}/ko-KR/tournament/${encodeURIComponent(tournamentId)}/overview`;
  const { data: html } = await client.get(url);
  const $ = load(html);
  const stages = new Map();
  $('main nav a[href*="/tournament/"][href*="/stage/"]').each((_, element) => {
    const href = $(element).attr('href');
    const match = href?.match(/\/tournament\/(\d+)\/stage\/(\d+)/);
    if (!match || match[1] !== String(tournamentId)) return;
    const labels = $(element).find('p').map((__, paragraph) => $(paragraph).text().trim()).get().filter(Boolean);
    stages.set(match[2], {
      id: match[2],
      tournamentId: match[1],
      name: labels[0] ?? '대회 단계',
      type: labels[1] ?? '',
      url: new URL(href, SITE_URL).href,
    });
  });
  if (!stages.size) throw new Error('공식 페이지에서 대회 단계를 찾지 못했습니다.');
  return setCached(cacheKey, [...stages.values()]);
}

function findRankingRow($, teamElement) {
  let row = $(teamElement);
  for (let depth = 0; depth < 6 && row.length; depth += 1) {
    const text = row.text().replace(/\s+/g, ' ').trim();
    const rank = row.children().first().text().trim();
    if (/^\d+$/.test(rank) && /\d+승\s*-\s*\d+패/.test(text) && row.find('[aria-label]').length === 1) return row;
    row = row.parent();
  }
  return null;
}

function parseGroups($) {
  const groups = [];
  $('[data-contains-groups="true"]').first().children().each((_, groupElement) => {
    const group = $(groupElement);
    const groupName = group.find('*').filter((__, element) => /조$/.test($(element).text().trim())).first().text().trim();
    const rows = [];
    const seen = new Set();
    group.find('[aria-label]').each((__, teamElement) => {
      const team = $(teamElement).attr('aria-label')?.trim();
      const image = $(teamElement).find('img').first().attr('src') ?? null;
      const row = findRankingRow($, teamElement);
      const rank = row?.children().first().text().trim();
      const record = row?.find('*').filter((___, element) =>
        /^\d+승\s*-\s*\d+패$/.test($(element).text().replace(/\s+/g, ' ').trim())
      ).last().text().replace(/\s+/g, ' ').trim();
      const key = `${rank}:${team}:${record}`;
      if (team && rank && record && !seen.has(key)) {
        seen.add(key);
        rows.push({ rank: Number(rank), team, image, record });
      }
    });
    if (rows.length) groups.push({ name: groupName || `그룹 ${groups.length + 1}`, rows });
  });
  return groups;
}

function parseBracket($) {
  const matches = [];
  const seen = new Set();
  $('[data-outcome][data-last-team][aria-label]').each((_, teamElement) => {
    const matchElement = $(teamElement).parent();
    const teams = matchElement.children('[data-outcome][data-last-team][aria-label]');
    if (teams.length !== 2) return;
    const parsedTeams = teams.map((__, element) => {
      const team = $(element);
      const numbers = team.text().match(/\d+/g) ?? [];
      return {
        name: team.attr('aria-label')?.trim() ?? '팀 미정',
        image: team.find('img').first().attr('src') ?? null,
        score: Number(numbers.at(-1) ?? 0),
        outcome: team.attr('data-outcome'),
      };
    }).get();
    const key = parsedTeams.map((team) => `${team.name}:${team.score}`).join('|');
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({ teams: parsedTeams });
    }
  });
  return matches;
}

function extractJsonObject(source, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return source.slice(startIndex, index + 1);
  }
  return null;
}

function parseFlightBracket($, stageId) {
  let payload = '';
  $('script').each((_, element) => {
    const script = $(element).html()?.trim() ?? '';
    if (!script.startsWith('self.__next_f.push(')) return;
    try {
      const values = JSON.parse(script.slice('self.__next_f.push('.length, -1));
      if (typeof values[1] === 'string') payload += values[1];
    } catch {
      // Ignore unrelated Next.js bootstrap chunks.
    }
  });

  const stageMarker = `{\"__typename\":\"Stage\",\"id\":\"${stageId}\"`;
  const stageIndex = payload.indexOf(stageMarker);
  const stageSource = stageIndex >= 0 ? extractJsonObject(payload, stageIndex) : null;
  if (!stageSource) return [];
  const stageMatchIds = new Set(
    [...stageSource.matchAll(/\{"__typename":"Match","id":"(\d+)"/g)].map((match) => match[1])
  );

  const matches = new Map();
  const marker = '{\"__typename\":\"Match\"';
  let markerIndex = payload.indexOf(marker);
  while (markerIndex >= 0) {
    const source = extractJsonObject(payload, markerIndex);
    if (!source) break;
    try {
      const match = JSON.parse(source);
      if (stageMatchIds.has(match.id) && match.matchTeams?.length === 2) {
        matches.set(match.id, {
          id: match.id,
          description: match.description,
          state: match.state,
          startTime: match.startTime,
          teams: match.matchTeams.map((team) => ({
            name: team.name?.trim() ?? team.code ?? '팀 미정',
            image: team.image ?? null,
            score: team.result?.gameWins ?? 0,
            outcome: team.result?.outcome,
          })),
        });
      }
    } catch {
      // Continue searching if a non-match payload happens to share the marker.
    }
    markerIndex = payload.indexOf(marker, markerIndex + source.length);
  }
  return [...matches.values()].sort((left, right) => new Date(left.startTime) - new Date(right.startTime));
}

export async function fetchOfficialStageDisplay(tournamentId, stageId) {
  const cacheKey = `stage:${tournamentId}:${stageId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const stages = await fetchTournamentStages(tournamentId);
  const stage = stages.find((item) => item.id === String(stageId));
  if (!stage) throw new Error('선택한 대회 단계를 찾지 못했습니다.');
  const { data: html } = await client.get(stage.url);
  const $ = load(html);
  const title = $('main h2').first().text().trim() || stage.name;
  const groups = parseGroups($);
  const matches = parseBracket($);
  if (!matches.length) matches.push(...parseFlightBracket($, stageId));
  return setCached(cacheKey, { title, stage, groups, matches });
}

export function getEventTeams(event) {
  return event.matchTeams ?? event.match?.teams ?? [];
}

export function getBestOfLabel(event) {
  const count = event.match?.strategy?.count;
  return Number.isInteger(count) && count > 0 ? `${count}전 ${Math.ceil(count / 2)}선승제` : '경기 방식 미정';
}
