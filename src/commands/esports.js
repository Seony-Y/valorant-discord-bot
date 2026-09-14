import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
  fetchOfficialStageDisplay,
  fetchTierOneEvents,
  fetchTournamentStages,
  formatKoreanDateTime,
  getBestOfLabel,
  getEventTeams,
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

function formatTeams(event, includeScore) {
  const teams = getEventTeams(event);
  if (teams.length < 2) return '대진 미정';
  return teams.map((team) => {
    const score = includeScore && Number.isInteger(team.result?.gameWins) ? ` ${team.result.gameWins}` : '';
    return `${(team.name ?? team.code ?? '팀 미정').trim()}${score}`;
  }).join(includeScore ? ' : ' : ' vs ');
}

function buildEventsEmbed(events, mode, year, leagueName) {
  const visible = mode === '일정'
    ? events.filter((event) => event.state !== 'completed').slice(0, 10)
    : events.filter((event) => event.state === 'completed').slice(-10).reverse();
  const description = visible.length
    ? visible.map((event) => [
      `**${formatKoreanDateTime(event.startTime)} · ${translateEventState(event.state)}**`,
      `${formatTeams(event, mode === '결과')} · ${getBestOfLabel(event)}`,
      `${event.league?.name ?? '공식 리그'} · ${event.tournament?.name ?? '공식 대회'}`,
    ].join('\n')).join('\n\n')
    : `조회 조건에 맞는 ${mode === '일정' ? '예정 경기' : '종료 경기'}가 없습니다.`;

  return new EmbedBuilder()
    .setTitle(`${year} ${leagueName} ${mode}`)
    .setDescription(description)
    .setColor(mode === '일정' ? 0x3ba7ff : 0xff4655)
    .setFooter({ text: 'VALORANT Esports 한국 공식 데이터 · 한국 시간 기준' });
}

async function showEvents(interaction, mode) {
  const year = interaction.options.getInteger('연도') ?? new Date().getFullYear();
  const leagueSlug = interaction.options.getString('리그') ?? 'all';
  const leagueName = LEAGUE_CHOICES.find((choice) => choice.value === leagueSlug)?.name ?? '전체';
  const events = await fetchTierOneEvents(year, leagueSlug === 'all' ? undefined : leagueSlug);
  await interaction.editReply({ embeds: [buildEventsEmbed(events, mode, year, leagueName)] });
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

  if (display.matches.length) {
    embed.setDescription(display.matches.map((match) => {
      const [first, second] = match.teams;
      return `${first.name} **${first.score} : ${second.score}** ${second.name}`;
    }).join('\n'));
    return embed;
  }

  embed.setDescription('공식 페이지에서 표시 가능한 순위 또는 브래킷 결과를 찾지 못했습니다. 제목 링크에서 최신 대진을 확인해주세요.');
  return embed;
}

async function showStandings(interaction) {
  let tournamentId = interaction.options.getString('대회');
  if (!tournamentId) {
    const tournaments = await getTournamentChoices();
    tournamentId = tournaments[0]?.id;
  }
  if (!tournamentId) throw new Error('조회 가능한 공식 대회가 없습니다.');

  const stages = await fetchTournamentStages(tournamentId);
  const requestedStageId = interaction.options.getString('단계');
  const stage = stages.find((item) => item.id === requestedStageId)
    ?? stages.find((item) => item.type === '그룹')
    ?? stages[0];
  const display = await fetchOfficialStageDisplay(tournamentId, stage.id);
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
