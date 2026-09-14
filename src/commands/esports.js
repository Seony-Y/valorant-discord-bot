import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import {
  fetchOfficialStageDisplay,
  fetchTierOneEvents,
  fetchTournamentStages,
  formatKoreanDateTime,
  getBestOfLabel,
  getEventTeams,
  getLatestTournamentChoice,
  getTournamentChoices,
  translateEventState,
} from '../services/valorantEsports.js';

const LEAGUE_CHOICES = [
  { name: '전체', value: 'all' },
  { name: 'VCT 퍼시픽', value: 'vct_pacific' },
  { name: 'VCT 아메리카스', value: 'vct_americas' },
  { name: 'VCT EMEA', value: 'vct_emea' },
  { name: 'VCT 차이나', value: 'vct_china' },
];
const MATCHES_PER_PAGE = 5;
const PAGINATION_TIMEOUT_MS = 15 * 60 * 1000;

function addCommonEventOptions(subcommand) {
  return subcommand
    .addStringOption((option) => option
      .setName('리그')
      .setDescription('조회할 공식 리그')
      .addChoices(...LEAGUE_CHOICES))
    .addIntegerOption((option) => option
      .setName('연도')
      .setDescription('조회할 시즌 연도')
      .setMinValue(2024)
      .setMaxValue(new Date().getFullYear() + 1));
}

export const data = new SlashCommandBuilder()
  .setName('대회')
  .setDescription('공식 VALORANT 대회 정보를 조회합니다.')
  .addSubcommand((subcommand) => addCommonEventOptions(subcommand
    .setName('일정')
    .setDescription('예정되었거나 진행 중인 공식 경기 일정을 조회합니다.')))
  .addSubcommand((subcommand) => subcommand
    .setName('순위')
    .setDescription('공식 대회의 팀별 순위표를 조회합니다.')
    .addStringOption((option) => option
      .setName('대회')
      .setDescription('조회할 공식 대회')
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('단계')
      .setDescription('팀별 순위표가 있는 그룹 단계')
      .setAutocomplete(true)))
  .addSubcommand((subcommand) => addCommonEventOptions(subcommand
    .setName('결과')
    .setDescription('종료된 공식 경기 결과를 조회합니다.')));

function truncateChoiceName(value) {
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();
  const year = new Date().getFullYear();

  try {
    if (focused.name === '대회') {
      const tournaments = await getTournamentChoices(year);
      await interaction.respond(tournaments
        .filter((tournament) => `${tournament.leagueName} ${tournament.name}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map((tournament) => ({
          name: truncateChoiceName(`${tournament.leagueName} · ${tournament.name}`),
          value: tournament.id,
        })));
      return;
    }

    if (focused.name === '단계') {
      const tournamentId = interaction.options.getString('대회');
      if (!tournamentId) {
        await interaction.respond([]);
        return;
      }
      const stages = await fetchTournamentStages(tournamentId);
      await interaction.respond(stages
        .filter((stage) => stage.type === '그룹')
        .filter((stage) => `${stage.name} ${stage.type}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map((stage) => ({ name: truncateChoiceName(`${stage.name} · ${stage.type}`), value: stage.id })));
    }
  } catch (error) {
    console.error('대회 자동완성 실패:', error.message);
    await interaction.respond([]).catch(() => {});
  }
}

function secureImageUrl(value) {
  return value?.replace(/^http:/, 'https:') ?? null;
}

function gameRecordLines(event) {
  return (event?.match?.games ?? [])
    .filter((game) => game.state !== 'unneeded')
    .map((game) => {
      const vodPath = game.vods?.[0]?.parameter
        ? `/ko-KR/vod/${event.id}/${game.number}/${game.vods[0].parameter}`
        : null;
      const vod = vodPath ? ` · [다시보기](https://valorantesports.com${vodPath})` : '';
      return `${game.number}세트 · ${translateEventState(game.state)}${vod}`;
    });
}

function matchCard(teams, details, options = {}) {
  const [first, second] = teams;
  if (!first || !second) {
    return new EmbedBuilder().setDescription('대진이 아직 확정되지 않았습니다.').setColor(0x3ba7ff);
  }
  const winner = teams.find((team) => team.outcome === 'win');
  const loser = teams.find((team) => team.outcome === 'loss');
  const firstName = (first.name ?? first.code ?? '팀 미정').trim();
  const secondName = (second.name ?? second.code ?? '팀 미정').trim();
  const embed = new EmbedBuilder().setColor(winner ? 0x57f287 : 0x3ba7ff);

  if (winner && loser) {
    const winnerName = (winner.name ?? winner.code ?? '승리 팀').trim();
    const loserName = (loser.name ?? loser.code ?? '상대 팀').trim();
    const winnerScore = winner.score ?? winner.result?.gameWins ?? 0;
    const loserScore = loser.score ?? loser.result?.gameWins ?? 0;
    const bestOf = options.bestOfCount ?? winnerScore * 2 - 1;
    const games = gameRecordLines(options.event);
    embed
      .setAuthor({ name: `${winnerName} 승리`, iconURL: secureImageUrl(winner.image) ?? undefined })
      .setTitle(`${winnerName} ${winnerScore} : ${loserScore} ${loserName}`)
      .setDescription([
        `**${winnerName} 승리 · 최종 스코어 ${winnerScore}:${loserScore}**`,
        `${bestOf}전 ${Math.ceil(bestOf / 2)}선승제`,
        ...details,
        ...(games.length ? ['', '**세트별 기록**', ...games] : []),
      ].filter((line) => line !== null && line !== undefined).join('\n'));
    return embed;
  }

  embed
    .setAuthor({ name: translateEventState(details.state) })
    .setTitle(`${firstName} vs ${secondName}`)
    .setDescription(details.lines.filter(Boolean).join('\n'));
  return embed;
}

function eventCard(event, mode) {
  const teams = getEventTeams(event).map((team) => ({
    ...team,
    name: (team.name ?? team.code ?? '팀 미정').trim(),
    score: team.result?.gameWins,
    outcome: team.result?.outcome,
  }));
  const lines = [
    `${formatKoreanDateTime(event.startTime)} · ${translateEventState(event.state)}`,
    mode === '일정' ? getBestOfLabel(event) : null,
    `${event.league?.name ?? '공식 리그'} · ${event.tournament?.name ?? '공식 대회'}`,
  ];
  return mode === '결과'
    ? matchCard(teams, lines, { event, bestOfCount: event.match?.strategy?.count })
    : matchCard(teams, { state: event.state, lines });
}

function matchNumber(match) {
  return Number(match.description?.match(/\d+/)?.[0] ?? 0);
}

function sortResultsLatest(matches, eventsById = new Map()) {
  return [...matches].sort((left, right) => {
    const numberDifference = matchNumber(right) - matchNumber(left);
    if (matchNumber(left) && matchNumber(right) && numberDifference) return numberDifference;
    const leftTime = eventsById.get(left.id)?.startTime ?? left.startTime;
    const rightTime = eventsById.get(right.id)?.startTime ?? right.startTime;
    const timeDifference = (rightTime ? new Date(rightTime).getTime() : 0)
      - (leftTime ? new Date(leftTime).getTime() : 0);
    return timeDifference || numberDifference;
  });
}

function paginationControls(interactionId, page, pageCount, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`esports-prev:${interactionId}`)
      .setLabel('이전')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page === 0),
    new ButtonBuilder()
      .setCustomId(`esports-next:${interactionId}`)
      .setLabel('다음')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || page === pageCount - 1)
  );
}

async function showMatchPages(interaction, matches, createEmbed, emptyMessage) {
  if (!matches.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setDescription(emptyMessage).setColor(0x3ba7ff)] });
    return;
  }

  let page = 0;
  const pageCount = Math.ceil(matches.length / MATCHES_PER_PAGE);
  const render = (disabled = false) => {
    const pageMatches = matches.slice(page * MATCHES_PER_PAGE, (page + 1) * MATCHES_PER_PAGE);
    const embeds = pageMatches.map(createEmbed);
    const lastEmbed = embeds.at(-1);
    lastEmbed.setFooter({
      text: `VALORANT Esports 한국 공식 · ${page + 1}/${pageCount} 페이지`,
    });
    return { embeds, components: [paginationControls(interaction.id, page, pageCount, disabled)] };
  };

  await interaction.editReply(render());
  if (pageCount === 1) return;
  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({ time: PAGINATION_TIMEOUT_MS });
  collector.on('collect', async (buttonInteraction) => {
    if (buttonInteraction.user.id !== interaction.user.id) {
      await buttonInteraction.reply({ content: '이 대회 조회를 실행한 사용자만 페이지를 이동할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    page += buttonInteraction.customId.startsWith('esports-next:') ? 1 : -1;
    await buttonInteraction.update(render());
  });
  collector.on('end', async () => interaction.editReply(render(true)).catch(() => {}));
}

async function showEvents(interaction, mode) {
  const year = interaction.options.getInteger('연도') ?? new Date().getFullYear();
  const leagueSlug = interaction.options.getString('리그') ?? 'all';
  const leagueName = LEAGUE_CHOICES.find((choice) => choice.value === leagueSlug)?.name ?? '전체';
  const events = await fetchTierOneEvents(year, leagueSlug === 'all' ? undefined : leagueSlug);
  const visible = mode === '일정'
    ? events.filter((event) => event.state !== 'completed')
    : sortResultsLatest(events.filter((event) => event.state === 'completed'));
  await showMatchPages(
    interaction,
    visible,
    (event) => eventCard(event, mode),
    `${year} ${leagueName}에서 조회 가능한 ${mode === '일정' ? '예정 경기' : '종료 경기'}가 없습니다.`
  );
}

function buildStandingsEmbed(display) {
  const embed = new EmbedBuilder()
    .setTitle(`${display.title} · ${display.stage.name}`)
    .setURL(display.stage.url)
    .setColor(0xff4655)
    .setFooter({ text: 'VALORANT Esports 한국 공식 순위 · 별도 계산 없음' });

  if (display.groups.length) {
    embed.addFields(display.groups.map((group) => ({
      name: group.name,
      value: group.rows.map((row) => `**${row.rank}위** ${row.team} · ${row.record}`).join('\n'),
      inline: display.groups.length > 1,
    })));
    return embed;
  }

  embed.setDescription('공식 페이지에서 표시 가능한 순위 또는 브래킷 결과를 찾지 못했습니다. 제목 링크에서 최신 대진을 확인해주세요.');
  return embed;
}

async function showStandings(interaction) {
  const requestedTournamentId = interaction.options.getString('대회');
  const requestedStageId = interaction.options.getString('단계');
  if (requestedStageId && !requestedTournamentId) {
    throw new Error('`단계` 옵션을 사용하려면 먼저 `대회` 옵션을 선택해주세요.');
  }

  let tournamentId = requestedTournamentId;
  if (!tournamentId) {
    tournamentId = (await getLatestTournamentChoice())?.id;
  }
  if (!tournamentId) throw new Error('조회 가능한 공식 대회가 없습니다.');

  let stages;
  try {
    stages = await fetchTournamentStages(tournamentId);
  } catch (error) {
    if (requestedTournamentId) throw new Error('선택한 대회를 찾을 수 없습니다. `대회` 옵션에서 다시 선택해주세요.');
    throw error;
  }
  let display;
  if (requestedStageId) {
    display = await fetchOfficialStageDisplay(tournamentId, requestedStageId);
    if (!display.groups.length) {
      throw new Error('선택한 단계에는 공식 팀 순위표가 없습니다. 경기 결과는 `/대회 결과`에서 확인해주세요.');
    }
  } else {
    for (const stage of [...stages].reverse().filter((item) => item.type === '그룹')) {
      const candidate = await fetchOfficialStageDisplay(tournamentId, stage.id);
      if (candidate.groups.length) {
        display = candidate;
        break;
      }
    }
  }
  if (!display) throw new Error('선택한 대회에는 공식 팀 순위표가 없습니다. 경기 결과는 `/대회 결과`에서 확인해주세요.');
  await interaction.editReply({ embeds: [buildStandingsEmbed(display)] });
}

function tournamentErrorMessage(error) {
  if (/^[^A-Za-z]*[가-힣]/.test(error?.message ?? '')) return error.message;
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return '공식 대회 서버 응답 시간이 초과됐습니다. 잠시 후 다시 시도해주세요.';
  }
  if (error?.response?.status === 404) {
    return '선택한 공식 대회 데이터를 찾을 수 없습니다. 옵션을 다시 선택해주세요.';
  }
  if ([401, 403].includes(error?.response?.status)) {
    return '공식 대회 서버가 요청을 거부했습니다. 잠시 후 다시 시도해주세요.';
  }
  return '공식 대회 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.';
}

export async function execute(interaction) {
  await interaction.deferReply();
  try {
    const action = interaction.options.getSubcommand();
    if (action === '순위') {
      await showStandings(interaction);
      return;
    }
    await showEvents(interaction, action);
  } catch (error) {
    console.error('대회 조회 실패:', error);
    await interaction.editReply({
      content: `대회 조회 실패: ${tournamentErrorMessage(error)}`,
      embeds: [],
      components: [],
    });
  }
}
