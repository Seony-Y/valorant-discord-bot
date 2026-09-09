import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import { getMMR, getMatchSummary, getSeasonMatchDetails, getValorantActs } from '../services/henrik.js';
import { computePowerScore } from '../services/scoring.js';
import { supabase } from '../services/supabase.js';

const MATCH_LOOKUP_SIZES = [20, 50, 100];
const MATCHES_TO_CONSIDER = 10;

async function getLatestAvailableMatchSummary(region, name, tag) {
  let lastError;
  for (const size of MATCH_LOOKUP_SIZES) {
    try {
      const summary = await getMatchSummary(region, name, tag, size);
      if (summary.gamesConsidered >= MATCHES_TO_CONSIDER || (size === MATCH_LOOKUP_SIZES.at(-1) && summary.gamesConsidered > 0)) {
        return summary;
      }
    } catch (error) {
      lastError = error;
      if (error?.response?.status && error.response.status !== 404) throw error;
    }
  }
  throw lastError ?? new Error('조회 가능한 최근 매치 기록이 없습니다.');
}

async function showSeasonMatchDetails(interaction, player, seasonId) {
  const [seasonMatches, acts] = await Promise.all([
    getSeasonMatchDetails(
      player.region,
      player.riot_name,
      player.riot_tag,
      seasonId
    ),
    getValorantActs(),
  ]);
  const selectedAct = acts.find((act) => act.id === seasonId);
  let seasonPageIndex = 0;
  let seasonSortMode = 'latest';
  const seasonPageSize = 10;
  const getSortedSeasonMatches = () => [...seasonMatches].sort((first, second) => {
    if (seasonSortMode === 'acs-high') return second.acs - first.acs || second.startedAt - first.startedAt;
    if (seasonSortMode === 'acs-low') return first.acs - second.acs || second.startedAt - first.startedAt;
    return second.startedAt - first.startedAt;
  });
  const getSeasonPageCount = () => Math.max(1, Math.ceil(seasonMatches.length / seasonPageSize));
  const seasonSortLabel = () => ({
    latest: '최신순',
    'acs-high': 'ACS 높은 순',
    'acs-low': 'ACS 낮은 순',
  })[seasonSortMode];
  const getSeasonControls = (disabled = false) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`stats-season-latest-${interaction.id}`)
        .setLabel('최신순')
        .setStyle(seasonSortMode === 'latest' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled || seasonMatches.length < 2),
      new ButtonBuilder()
        .setCustomId(`stats-season-acs-high-${interaction.id}`)
        .setLabel('ACS 높은 순')
        .setStyle(seasonSortMode === 'acs-high' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled || seasonMatches.length < 2),
      new ButtonBuilder()
        .setCustomId(`stats-season-acs-low-${interaction.id}`)
        .setLabel('ACS 낮은 순')
        .setStyle(seasonSortMode === 'acs-low' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled || seasonMatches.length < 2),
      new ButtonBuilder()
        .setCustomId(`stats-season-prev-${interaction.id}`)
        .setLabel('이전')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || seasonPageIndex === 0),
      new ButtonBuilder()
        .setCustomId(`stats-season-next-${interaction.id}`)
        .setLabel('다음')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || seasonPageIndex === getSeasonPageCount() - 1)
    );
  const getSeasonMatchEmbed = () => {
    const pageMatches = getSortedSeasonMatches().slice(seasonPageIndex * seasonPageSize, (seasonPageIndex + 1) * seasonPageSize);
    const seasonMatchLines = pageMatches.length
      ? pageMatches
        .map(
          (match, index) =>
            `${seasonPageIndex * seasonPageSize + index + 1}. ${match.map} ${match.result} · ${match.agent} · ${match.kills}/${match.deaths}/${match.assists} · ACS ${match.acs} · ADR ${match.damagePerRound}`
        )
        .join('\n')
      : '최근 100경기에서 해당 시즌의 경쟁전/일반게임 기록을 찾지 못했습니다.';
    return new EmbedBuilder()
      .setTitle(`${selectedAct?.name ?? '선택 시즌'} 경기별 기록`)
      .setDescription(seasonMatchLines)
      .setColor(0xf1c40f)
      .setFooter({ text: `최근 100경기 내 ${seasonMatches.length}개 · ${seasonSortLabel()} · ${seasonPageIndex + 1}/${getSeasonPageCount()} 페이지` });
  };

  await interaction.editReply({ embeds: [getSeasonMatchEmbed()], components: [getSeasonControls()] });
  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({ time: 24 * 60 * 60 * 1000 });

  collector.on('collect', async (buttonInteraction) => {
    if (buttonInteraction.user.id !== interaction.user.id) {
      await buttonInteraction.reply({ content: '이 전적 조회를 실행한 사용자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (buttonInteraction.customId.includes('latest')) seasonSortMode = 'latest';
    else if (buttonInteraction.customId.includes('acs-high')) seasonSortMode = 'acs-high';
    else if (buttonInteraction.customId.includes('acs-low')) seasonSortMode = 'acs-low';
    else seasonPageIndex += buttonInteraction.customId.includes('next') ? 1 : -1;
    if (buttonInteraction.customId.includes('season-acs') || buttonInteraction.customId.includes('season-latest')) {
      seasonPageIndex = 0;
    }
    await buttonInteraction.update({ embeds: [getSeasonMatchEmbed()], components: [getSeasonControls()] });
  });

  collector.on('end', async () => {
    await interaction.editReply({ components: [getSeasonControls(true)] }).catch(() => {});
  });
}

export const data = new SlashCommandBuilder()
  .setName('전적')
  .setDescription('KDA / KD / ACS / 승률 / 헤드샷 / 캐릭터 / 맵별 전적 / 티어를 조회합니다.')
  .addStringOption((opt) =>
    opt.setName('이름').setDescription('조회할 Riot ID 이름 (# 앞부분, 미지정시 본인)').setRequired(false)
  )
  .addStringOption((opt) =>
    opt.setName('태그').setDescription('조회할 Riot ID 태그 (# 뒷부분)').setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName('지역')
      .setDescription('Riot 계정 지역 (이름/태그 입력 시 필수)')
      .setRequired(false)
      .addChoices(
        { name: '한국/아시아 (kr)', value: 'kr' },
        { name: '북미 (na)', value: 'na' },
        { name: '유럽 (eu)', value: 'eu' },
        { name: '아시아태평양 (ap)', value: 'ap' }
      )
  )
  .addBooleanOption((opt) =>
    opt.setName('경기별').setDescription('최근 경기별 기록 페이지를 함께 표시합니다.').setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt.setName('스킬사용기록').setDescription('최근 경기별 스킬 사용 횟수와 KDA를 합계/평균으로 함께 표시합니다.').setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName('시즌')
      .setDescription('시즌별 최근 경기 기록을 표시합니다.')
      .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  const query = interaction.options.getFocused().toLowerCase();
  const acts = await getValorantActs();
  const choices = acts
    .filter((act) => act.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map((act) => ({ name: act.name, value: act.id }));
  await interaction.respond(choices);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const riotName = interaction.options.getString('이름')?.trim();
  const riotTag = interaction.options.getString('태그')?.trim();
  const region = interaction.options.getString('지역');
  const showMatchDetails = interaction.options.getBoolean('경기별') ?? false;
  const showSkillUsage = interaction.options.getBoolean('스킬사용기록') ?? false;
  const seasonId = interaction.options.getString('시즌');

  if ((riotName || riotTag) && (!riotName || !riotTag || !region)) {
    await interaction.editReply('다른 계정을 조회하려면 Riot 이름, 태그, 지역을 모두 입력해주세요.');
    return;
  }

  let player;
  let error;
  const isOwnAccount = !riotName && !riotTag;

  if (isOwnAccount) {
    const result = await supabase
      .from('players')
      .select('*')
      .eq('discord_id', interaction.user.id)
      .single();
    player = result.data;
    error = result.error;
  } else {
    player = { riot_name: riotName, riot_tag: riotTag, region };
  }

  if (error || !player) {
    await interaction.editReply('등록된 계정이 없습니다. 본인 조회는 먼저 `/계정등록`을 사용해주세요.');
    return;
  }

  try {
    if (seasonId) {
      await showSeasonMatchDetails(interaction, player, seasonId);
      return;
    }

    let mmr = null;
    let matchSummary = null;
    const lookupErrors = [];

    try {
      mmr = await getMMR(player.region, player.riot_name, player.riot_tag);
    } catch (error) {
      lookupErrors.push(`티어: ${error.message}`);
    }

    try {
      matchSummary = await getLatestAvailableMatchSummary(player.region, player.riot_name, player.riot_tag);
    } catch (error) {
      lookupErrors.push(`최근 전적: ${error.message}`);
    }

    if (!mmr && !matchSummary) {
      await interaction.editReply(`조회 가능한 전적이 없습니다.\n${lookupErrors.join('\n')}`);
      return;
    }

    const powerScore = mmr && matchSummary
      ? computePowerScore({
          kda: matchSummary.kda,
          acs: matchSummary.acs,
          currentTier: mmr.currentTier,
          peakTier: mmr.peakTier,
        })
      : null;

    if (isOwnAccount && mmr && matchSummary) {
      await supabase.from('stats_cache').upsert({
        discord_id: interaction.user.id,
        kda: matchSummary.kda,
        top_agents: matchSummary.topAgents,
        map_winrates: matchSummary.mapWinrates,
        current_tier: mmr.currentTier,
        peak_tier: mmr.peakTier,
        power_score: powerScore,
        updated_at: new Date().toISOString(),
      });
    }

    const agentLines = matchSummary?.topAgents?.length
      ? matchSummary.topAgents
      .map((a, i) => `${i + 1}. **${a.agent}** — ${a.games}경기 / 플레이율 ${a.playRate}% / 승률 ${a.winRate}%`)
      .join('\n')
      : '최근 매치 없음';

    const mapLines = matchSummary
      ? Object.entries(matchSummary.mapWinrates)
        .map(
          ([map, winRate]) =>
            `${map}: (${matchSummary.mapWins[map]}승 / ${matchSummary.mapGames[map] - matchSummary.mapWins[map]}패 / ${winRate}%)`
        )
        .join('\n') || '맵 기록 없음'
      : '최근 매치 없음';

    const weaponLines = matchSummary?.weapons?.length
      ? matchSummary.weapons
        .map((weapon) => `**${weapon.weapon}**: ${weapon.kills}킬 / kill ratio **${weapon.killRate}%**`)
        .join('\n')
      : '최근 매치 없음';

    const matchLines = matchSummary?.matchDetails?.length
      ? matchSummary.matchDetails
        .slice(0, 10)
        .map(
          (match, index) =>
            `${index + 1}. ${match.map} ${match.result} · ${match.agent} · ${match.kills}/${match.deaths}/${match.assists} · ACS ${match.acs} · ADR ${match.damagePerRound}`
        )
        .join('\n')
      : '최근 매치 없음';

    const matchSummaryDescription = !matchSummary
      ? '최근 매치 데이터를 찾지 못했습니다.'
      : matchSummary.gamesConsidered < MATCHES_TO_CONSIDER
        ? `최근 ${MATCH_LOOKUP_SIZES.at(-1)}경기 조회 결과, 경쟁전/일반게임 ${matchSummary.gamesConsidered}경기만 확인되어 해당 기록으로 측정했습니다.`
        : `최근 ${MATCHES_TO_CONSIDER}경기 기준 전적 요약`;

    const skillUsageLines = matchSummary?.matchDetails?.length
      ? matchSummary.matchDetails
        .slice(0, 10)
        .map(
          (match, index) =>
            `${index + 1}. ${match.map} · ${match.agent} · KDA ${match.kills}/${match.deaths}/${match.assists} · Q ${match.abilityCasts.q} / C ${match.abilityCasts.c} / E ${match.abilityCasts.e} / X ${match.abilityCasts.x}`
        )
        .join('\n')
      : '최근 매치 없음';

    const summaryEmbed = new EmbedBuilder()
      .setTitle(`${player.riot_name}#${player.riot_tag} 전적`)
      .setDescription(matchSummaryDescription)
      .addFields(
        {
          name: '티어',
          value: mmr ? `현재  **${mmr.currentTier}**\n최고  **${mmr.peakTier}**` : '조회 불가',
          inline: true,
        },
        {
          name: 'KDA / KD',
          value: matchSummary
            ? `KDA: **${matchSummary.kda}**\nKD: **${matchSummary.kd}** (최근 ${matchSummary.gamesConsidered}경기)`
            : '최근 매치 없음',
          inline: true,
        },
        {
          name: `경기 성과 (최근 ${matchSummary?.gamesConsidered ?? 0}경기)`,
          value: matchSummary
            ? `승률: **${matchSummary.winRate}%**\n` +
              `ACS: **${matchSummary.acs}**\n` +
              `ADR: **${matchSummary.damagePerRound}**\n` +
              `명중 부위: 머리 **${matchSummary.headshotRate}%** / 몸 **${matchSummary.bodyshotRate}%** / 다리 **${matchSummary.legshotRate}%**`
            : '최근 매치 없음',
          inline: false,
        },
        {
          name: '파워 스코어',
          value: powerScore === null
            ? '티어와 최근 전적이 모두 있어야 계산할 수 있습니다.'
            : `**${powerScore.toFixed(1)}**\n팀 밸런싱용 개인 지표 점수\n티어 있음: ACS 40% / KDA 50% / 티어 10%\n티어 없음: ACS 50% / KDA 50%`,
          inline: true,
        },
      )
      .setColor(0xff4655)
      .setFooter({ text: 'VALORANT 전적 분석' });

    const detailEmbed = new EmbedBuilder()
      .setTitle('상세 기록')
      .addFields(
        { name: '최근 캐릭터 TOP5 (승률)', value: agentLines, inline: false },
        { name: `총기별 킬 TOP5 (최근 ${matchSummary?.gamesConsidered ?? 0}경기)`, value: weaponLines, inline: false },
        { name: `맵별 승률 (최근 ${matchSummary?.gamesConsidered ?? 0}경기)`, value: mapLines, inline: false }
      )
      .setColor(0x3ba7ff)
      .setFooter({ text: '킬 수, 승률, 플레이 횟수를 포함한 상세 기록' });

    const matchEmbed = new EmbedBuilder()
      .setTitle('최근 경기별 기록')
      .setDescription(matchLines)
      .setColor(0x57f287)
      .setFooter({ text: '최근 경기 최대 10개 표시' });

    const skillUsageEmbed = new EmbedBuilder()
      .setTitle('게임별 스킬 사용 기록')
      .setDescription(
        `${matchSummary ? `최근 ${matchSummary.gamesConsidered}경기 기준\n` : ''}` +
        `합계: Q ${matchSummary?.abilityUsage?.q ?? 0} / C ${matchSummary?.abilityUsage?.c ?? 0} / E ${matchSummary?.abilityUsage?.e ?? 0} / X ${matchSummary?.abilityUsage?.x ?? 0}\n` +
        `평균: Q ${(matchSummary?.abilityUsage?.q ?? 0) / Math.max(matchSummary?.gamesConsidered ?? 1, 1)} / ` +
        `C ${(matchSummary?.abilityUsage?.c ?? 0) / Math.max(matchSummary?.gamesConsidered ?? 1, 1)} / ` +
        `E ${(matchSummary?.abilityUsage?.e ?? 0) / Math.max(matchSummary?.gamesConsidered ?? 1, 1)} / ` +
        `X ${(matchSummary?.abilityUsage?.x ?? 0) / Math.max(matchSummary?.gamesConsidered ?? 1, 1)}` +
        `\n\n${skillUsageLines}`
      )
      .setColor(0x9b59b6)
      .setFooter({ text: '최근 경기별 스킬 사용 횟수와 KDA' });

    const pages = [summaryEmbed, detailEmbed];
    let pageIndex = 0;
    const getButtons = (disabled = false) =>
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`stats-prev-${interaction.user.id}`)
          .setLabel('이전')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || pageIndex === 0),
        new ButtonBuilder()
          .setCustomId(`stats-next-${interaction.user.id}`)
          .setLabel('다음')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled || pageIndex === pages.length - 1)
      );

    await interaction.editReply({ embeds: [pages[pageIndex]], components: [getButtons()] });
    if (showMatchDetails) {
      await interaction.followUp({ embeds: [matchEmbed], flags: MessageFlags.Ephemeral });
    }
    if (showSkillUsage) {
      await interaction.followUp({ embeds: [skillUsageEmbed], flags: MessageFlags.Ephemeral });
    }
    if (seasonId) {
      const seasonReply = await interaction.followUp({
        embeds: [getSeasonMatchEmbed()],
        components: [getSeasonControls()],
        fetchReply: true,
      });
      const seasonCollector = seasonReply.createMessageComponentCollector({ time: 2 * 60 * 1000 });

      seasonCollector.on('collect', async (buttonInteraction) => {
        if (buttonInteraction.user.id !== interaction.user.id) {
          await buttonInteraction.reply({ content: '이 전적 조회를 실행한 사용자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (buttonInteraction.customId.includes('date-order')) {
          seasonSortMode = seasonSortMode === 'oldest' ? 'latest' : 'oldest';
          seasonPageIndex = 0;
        } else if (buttonInteraction.customId.includes('acs-order')) {
          seasonSortMode = seasonSortMode === 'acs-low' ? 'acs-high' : 'acs-low';
          seasonPageIndex = 0;
        } else {
          seasonPageIndex += buttonInteraction.customId.includes('next') ? 1 : -1;
        }
        await buttonInteraction.update({ embeds: [getSeasonMatchEmbed()], components: [getSeasonControls()] });
      });

      seasonCollector.on('end', async () => {
        await seasonReply.edit({ components: [getSeasonControls(true)] }).catch(() => {});
      });
    }
    const reply = await interaction.fetchReply();
    const collector = reply.createMessageComponentCollector({ time: 2 * 60 * 1000 });

    collector.on('collect', async (buttonInteraction) => {
      if (buttonInteraction.user.id !== interaction.user.id) {
        await buttonInteraction.reply({ content: '이 전적 조회를 실행한 사용자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
        return;
      }

      pageIndex += buttonInteraction.customId.includes('next') ? 1 : -1;
      await buttonInteraction.update({ embeds: [pages[pageIndex]], components: [getButtons()] });
    });

    collector.on('end', async () => {
      await interaction.editReply({ components: [getButtons(true)] }).catch(() => {});
    });
  } catch (err) {
    if (err.response?.status === 429) {
      await interaction.editReply('Henrik API 요청이 많아 시즌 전적 조회가 잠시 제한되었습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    await interaction.editReply(
      `전적 조회에 실패했습니다.\n${err.message}\n` +
        '예: 이름=나구링, 태그=NAGU, 지역=kr (Riot ID의 # 앞/뒤 값을 사용하세요.)'
    );
  }
}
