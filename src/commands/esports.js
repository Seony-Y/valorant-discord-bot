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
    .setDescription('공식 대회 순위표 또는 브래킷 결과를 조회합니다.')
    .addStringOption((option) => option
      .setName('대회')
      .setDescription('조회할 공식 대회')
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('단계')
      .setDescription('정규 리그, 플레이-인 또는 플레이오프')
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
    const loserImage = secureImageUrl(loser.image);
    embed.setFooter({ text: loserName, iconURL: loserImage ?? undefined });
    return embed;
  }

  embed
    .setAuthor({ name: translateEventState(details.state), iconURL: secureImageUrl(first.image) ?? undefined })
    .setTitle(`${firstName} vs ${secondName}`)
    .setDescription(details.lines.filter(Boolean).join('\n'));
  const secondImage = secureImageUrl(second.image);
  embed.setFooter({ text: secondName, iconURL: secondImage ?? undefined });
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
    const existingFooter = lastEmbed.data.footer;
    lastEmbed.setFooter({
      text: [existingFooter?.text, `한국 공식 · ${page + 1}/${pageCount} 페이지`].filter(Boolean).join(' · '),
      iconURL: existingFooter?.icon_url,
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
    : events.filter((event) => event.state === 'completed').reverse();
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
  let tournamentId = interaction.options.getString('대회');
  if (!tournamentId) {
    tournamentId = (await getLatestTournamentChoice())?.id;
  }
  if (!tournamentId) throw new Error('조회 가능한 공식 대회가 없습니다.');

  const stages = await fetchTournamentStages(tournamentId);
  const requestedStageId = interaction.options.getString('단계');
  let display;
  if (requestedStageId) {
    display = await fetchOfficialStageDisplay(tournamentId, requestedStageId);
  } else {
    for (const stage of [...stages].reverse()) {
      const candidate = await fetchOfficialStageDisplay(tournamentId, stage.id);
      if (candidate.groups.length || candidate.matches.length) {
        display = candidate;
        break;
      }
    }
  }
  if (!display) throw new Error('선택한 대회의 공식 순위 데이터를 찾지 못했습니다.');
  if (display.matches.length) {
    const events = await fetchTierOneEvents();
    const eventsById = new Map(events.map((event) => [event.id, event]));
    await showMatchPages(
      interaction,
      display.matches,
      (match) => {
        const event = eventsById.get(match.id);
        const startTime = event?.startTime ?? match.startTime;
        return matchCard(
          match.teams,
          [startTime ? formatKoreanDateTime(startTime) : null, `${display.title} · ${display.stage.name}`],
          { event, bestOfCount: event?.match?.strategy?.count }
        );
      },
      '공식 페이지에서 브래킷 결과를 찾지 못했습니다.'
    );
    return;
  }
  await interaction.editReply({ embeds: [buildStandingsEmbed(display)] });
}

export async function execute(interaction) {
  await interaction.deferReply();
  const action = interaction.options.getSubcommand();
  if (action === '순위') {
    await showStandings(interaction);
    return;
  }
  await showEvents(interaction, action);
}
