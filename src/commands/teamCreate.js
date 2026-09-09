import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { balanceTeams } from '../services/teamBalancer.js';
import { getOrRefreshPowerScore, getPowerScoreForRiotAccount } from '../services/teamPower.js';
import { supabase } from '../services/supabase.js';

const MAX_PLAYERS = 15;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const RESULT_DELETE_DELAY_MS = 10 * 60 * 1000;

export const data = new SlashCommandBuilder()
  .setName('팀짜기')
  .setDescription('수동 참가 또는 Riot 계정 직접 입력으로 두 팀을 나눕니다.')
  .addStringOption((opt) =>
    opt
      .setName('방식')
      .setDescription('수동은 버튼 참가, 자동은 Riot 계정 직접 입력')
      .setRequired(true)
      .addChoices(
        { name: '수동 - 버튼으로 참가', value: 'manual' },
        { name: '자동 - Riot 계정 직접 입력', value: 'automatic' }
      )
  )
  .addIntegerOption((opt) =>
    opt
      .setName('팀수')
      .setDescription('나눌 팀 수 (기본값: 2팀)')
      .setRequired(false)
      .addChoices(
        { name: '2팀', value: 2 },
        { name: '3팀', value: 3 }
      )
  );

function manualControls(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('team-join').setLabel('참가').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('team-leave').setLabel('나가기').setEmoji('🚪').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('team-balance').setLabel('팀 나누기').setEmoji('⚖️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('team-cancel').setLabel('취소').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled)
  );
}

function automaticControls(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('team-auto-add').setLabel('계정 추가').setEmoji('➕').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('team-auto-balance').setLabel('팀 나누기').setEmoji('⚖️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('team-auto-cancel').setLabel('취소').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled)
  );
}

function manualLobbyEmbed(owner, participants, teamCount) {
  const names = participants.map((user) => `• <@${user.id}>`).join('\n') || '아직 참가자가 없습니다.';
  return new EmbedBuilder()
    .setTitle('수동 팀짜기')
    .setDescription('참가 버튼을 누른 뒤, 모두 들어오면 주최자가 팀 나누기를 눌러주세요.')
    .addFields(
      { name: `참가자 ${participants.length}/${MAX_PLAYERS}`, value: names },
      { name: '주최자', value: `<@${owner.id}>`, inline: true },
      { name: '조건', value: `최소 ${teamCount}명 · 최대 ${MAX_PLAYERS}명 · ${teamCount}팀`, inline: true }
    )
    .setColor(0x3ba7ff);
}

function automaticLobbyEmbed(owner, accounts, teamCount) {
  const names = accounts.map((account) => `• ${account.name}#${account.tag} (${account.region.toUpperCase()})`).join('\n') || '아직 등록된 계정이 없습니다.';
  return new EmbedBuilder()
    .setTitle('자동 팀짜기')
    .setDescription('계정 추가 버튼으로 한 명씩 등록한 뒤, 주최자가 팀 나누기를 눌러주세요.')
    .addFields(
      { name: `등록 계정 ${accounts.length}/${MAX_PLAYERS}`, value: names },
      { name: '주최자', value: `<@${owner.id}>`, inline: true },
      { name: '조건', value: `최소 ${teamCount}명 · 최대 ${MAX_PLAYERS}명 · ${teamCount}팀`, inline: true },
      { name: '입력 형식', value: '계정마다 서버 선택 후 Riot 이름 · 태그 입력', inline: false }
    )
    .setColor(0x9b59b6);
}

function resultEmbed(teams, teamScores) {
  const playerLabel = (player) =>
    player.id ? `<@${player.id}>  ${player.name}` : `${player.name}#${player.tag}`;
  const labels = ['A', 'B', 'C'];

  return new EmbedBuilder()
    .setTitle('팀 매칭 결과')
    .setDescription('최근 전적의 파워 스코어 합계가 가장 비슷하도록 나눴습니다.')
    .addFields(
      ...teams.map((team, index) => ({
        name: `팀 ${labels[index]} · ${teamScores[index].toFixed(1)}`,
        value: team.map(playerLabel).join('\n') || '-',
        inline: true,
      }))
    )
    .setColor(0x57f287)
    .setFooter({ text: '파워 스코어 기반 팀 밸런싱' });
}

async function createTeamThread(interaction, mode) {
  if (!interaction.channel?.threads) {
    throw new Error('이 채널에서는 팀짜기 스레드를 만들 수 없습니다. 일반 텍스트 채널에서 다시 실행해주세요.');
  }

  const thread = await interaction.channel.threads.create({
    name: `팀짜기-${interaction.user.username}`.slice(0, 90),
    type: mode === 'automatic' ? ChannelType.PrivateThread : ChannelType.PublicThread,
    autoArchiveDuration: 60,
    ...(mode === 'automatic' ? { invitable: false } : {}),
  });

  if (mode === 'automatic') await thread.members.add(interaction.user.id);
  return thread;
}

async function handleAutomaticAccountAdd(interaction, buttonInteraction, lobbyMessage, accounts, teamCount) {
  if (accounts.length >= MAX_PLAYERS) {
    await buttonInteraction.reply({ content: '계정은 최대 10명까지 등록할 수 있습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`team-auto-account-${interaction.id}`)
    .setTitle(`계정 추가 (${accounts.length + 1}/${MAX_PLAYERS})`)
    .addComponents(
      new LabelBuilder()
        .setLabel('서버')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('riot-region')
            .setPlaceholder('서버 선택')
            .addOptions(
              { label: '한국/아시아', value: 'kr', description: 'kr', default: true },
              { label: '북미', value: 'na', description: 'na' },
              { label: '유럽', value: 'eu', description: 'eu' },
              { label: '아시아태평양', value: 'ap', description: 'ap' }
            )
        ),
      new LabelBuilder()
        .setLabel('Riot 이름')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('riot-name')
            .setPlaceholder('예: GULING')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
      new LabelBuilder()
        .setLabel('Riot Name Tag')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('riot-tag')
            .setPlaceholder('예: KR1')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
    );
  await buttonInteraction.showModal(modal);

  try {
    const modalSubmit = await buttonInteraction.awaitModalSubmit({
      filter: (submitted) => submitted.user.id === interaction.user.id,
      time: 120_000,
    });
      await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });
      const account = {
        name: modalSubmit.fields.getTextInputValue('riot-name').trim(),
        tag: modalSubmit.fields.getTextInputValue('riot-tag').trim(),
        region: modalSubmit.fields.getStringSelectValues('riot-region')[0],
      };
      const duplicate = accounts.some(
        (item) => item.name.toLowerCase() === account.name.toLowerCase() && item.tag.toLowerCase() === account.tag.toLowerCase() && item.region === account.region
      );
      if (duplicate) {
        await modalSubmit.editReply('이미 등록된 계정입니다.');
        return;
      }

      await modalSubmit.editReply('Riot 계정과 최근 전적을 확인하는 중입니다...');
      let scoredAccount;
      try {
        scoredAccount = await getPowerScoreForRiotAccount(account.name, account.tag, account.region);
      } catch (error) {
        await modalSubmit.editReply(`계정 등록에 실패했습니다.\n${error.message}\n이름, 태그, 서버를 확인해주세요.`);
        return;
      }

      accounts.push(scoredAccount);
      await modalSubmit.editReply(`${account.name}#${account.tag} (${account.region.toUpperCase()}) 등록 완료\n파워 스코어: ${scoredAccount.powerScore.toFixed(1)}`);
      await lobbyMessage.edit({ embeds: [automaticLobbyEmbed(interaction.user, accounts, teamCount)], components: [automaticControls()] });
  } catch (error) {
    if (error?.code !== 'InteractionCollectorError' && error?.code !== 10062) throw error;
  }
}

async function handleAutomaticMode(interaction, thread, teamCount) {
  await interaction.editReply(`비공개 자동 팀짜기 스레드를 만들었습니다: ${thread}`);

  const accounts = [];
  const lobbyMessage = await thread.send({
    content: `<@${interaction.user.id}> 비공개 자동 팀짜기 스레드입니다.`,
    embeds: [automaticLobbyEmbed(interaction.user, accounts, teamCount)],
    components: [automaticControls()],
  });
  const collector = lobbyMessage.createMessageComponentCollector({ time: SESSION_TIMEOUT_MS });
  const activityCollector = thread.createMessageCollector({ filter: (message) => !message.author.bot });

  activityCollector.on('collect', () => collector.resetTimer());

  collector.on('collect', async (buttonInteraction) => {
    if (buttonInteraction.user.id !== interaction.user.id) {
      await buttonInteraction.reply({ content: '주최자만 계정을 추가하거나 팀을 나눌 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    collector.resetTimer();

    if (buttonInteraction.customId === 'team-auto-add') {
      await handleAutomaticAccountAdd(interaction, buttonInteraction, lobbyMessage, accounts, teamCount);
      return;
    }

    if (buttonInteraction.customId === 'team-auto-cancel') {
      collector.stop('cancelled');
      await buttonInteraction.update({ content: '자동 팀짜기가 취소되었습니다.', embeds: [], components: [] });
      await thread.delete().catch(() => {});
      return;
    }

    if (buttonInteraction.customId === 'team-auto-balance') {
      if (accounts.length < teamCount) {
        await buttonInteraction.reply({ content: `${teamCount}팀으로 나누려면 최소 ${teamCount}개의 계정을 등록해주세요.`, flags: MessageFlags.Ephemeral });
        return;
      }

      await buttonInteraction.deferUpdate();
      try {
        const result = balanceTeams(accounts, teamCount);
        collector.stop('balanced');
        await lobbyMessage.edit({
          content: '자동 팀짜기가 완료되었습니다. 이 비공개 스레드는 10분 후 삭제됩니다.',
          embeds: [resultEmbed(result.teams, result.teamScores)],
          components: [automaticControls(true)],
        });
        setTimeout(() => thread.delete().catch(() => {}), RESULT_DELETE_DELAY_MS).unref();
      } catch (error) {
        await thread.send(`자동 팀 계산에 실패했습니다: ${error.message}`);
      }
    }
  });

  collector.on('end', async (__, reason) => {
    activityCollector.stop();
    if (reason === 'time') {
      await lobbyMessage.edit({ content: '자동 팀짜기 시간이 만료되었습니다.', components: [automaticControls(true)] }).catch(() => {});
      setTimeout(() => thread.delete().catch(() => {}), 5_000).unref();
    }
  });
}

async function handleManualMode(interaction, thread, teamCount) {
  const participants = new Map([[interaction.user.id, interaction.user]]);
  const lobbyMessage = await thread.send({
    content: `<@${interaction.user.id}> 팀짜기 스레드가 열렸습니다.`,
    embeds: [manualLobbyEmbed(interaction.user, [...participants.values()], teamCount)],
    components: [manualControls()],
  });

  await interaction.editReply(`팀짜기 스레드를 만들었습니다: ${thread}`);

  const collector = lobbyMessage.createMessageComponentCollector({ time: SESSION_TIMEOUT_MS });
  const activityCollector = thread.createMessageCollector({ filter: (message) => !message.author.bot });

  activityCollector.on('collect', () => collector.resetTimer());

  collector.on('collect', async (buttonInteraction) => {
    const user = buttonInteraction.user;
    collector.resetTimer();

    if (buttonInteraction.customId === 'team-join') {
      if (participants.has(user.id)) {
        await buttonInteraction.reply({ content: '이미 참가 중입니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (participants.size >= MAX_PLAYERS) {
        await buttonInteraction.reply({ content: '참가자는 최대 10명까지 가능합니다.', flags: MessageFlags.Ephemeral });
        return;
      }

      const { data: player, error } = await supabase
        .from('players')
        .select('*')
        .eq('discord_id', user.id)
        .single();

      if (error || !player) {
        await buttonInteraction.reply({ content: '먼저 `/계정등록`으로 Riot 계정을 연결해주세요.', flags: MessageFlags.Ephemeral });
        return;
      }

      participants.set(user.id, user);
      await buttonInteraction.update({ embeds: [manualLobbyEmbed(interaction.user, [...participants.values()], teamCount)], components: [manualControls()] });
      return;
    }

    if (buttonInteraction.customId === 'team-leave') {
      if (user.id === interaction.user.id) {
        await buttonInteraction.reply({ content: '주최자는 나갈 수 없습니다. 취소를 사용해주세요.', flags: MessageFlags.Ephemeral });
        return;
      }
      participants.delete(user.id);
      await buttonInteraction.update({ embeds: [manualLobbyEmbed(interaction.user, [...participants.values()], teamCount)], components: [manualControls()] });
      return;
    }

    if (buttonInteraction.customId === 'team-cancel') {
      if (user.id !== interaction.user.id) {
        await buttonInteraction.reply({ content: '주최자만 취소할 수 있습니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      collector.stop('cancelled');
      await buttonInteraction.update({ content: '팀짜기가 취소되었습니다.', embeds: [], components: [] });
      setTimeout(() => thread.delete().catch(() => {}), 5_000).unref();
      return;
    }

    if (buttonInteraction.customId === 'team-balance') {
      if (user.id !== interaction.user.id) {
        await buttonInteraction.reply({ content: '주최자만 팀을 나눌 수 있습니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (participants.size < teamCount) {
        await buttonInteraction.reply({ content: `${teamCount}팀으로 나누려면 최소 ${teamCount}명이 참가해야 합니다.`, flags: MessageFlags.Ephemeral });
        return;
      }

      await buttonInteraction.deferUpdate();
      try {
        const scored = await Promise.all([...participants.values()].map(getOrRefreshPowerScore));
        const result = balanceTeams(scored, teamCount);
        collector.stop('balanced');
        await lobbyMessage.edit({
          content: '팀짜기가 완료되었습니다. 이 스레드는 10분 후 삭제됩니다.',
          embeds: [resultEmbed(result.teams, result.teamScores)],
          components: [manualControls(true)],
        });
        setTimeout(() => thread.delete().catch(() => {}), RESULT_DELETE_DELAY_MS).unref();
      } catch (error) {
        await thread.send(`팀 계산에 실패했습니다: ${error.message}`);
      }
    }
  });

  collector.on('end', async (__, reason) => {
    activityCollector.stop();
    if (reason === 'time') {
      await lobbyMessage.edit({ content: '팀짜기 시간이 만료되었습니다.', components: [manualControls(true)] }).catch(() => {});
      setTimeout(() => thread.delete().catch(() => {}), 5_000).unref();
    }
  });
}

export async function execute(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: '서버 안에서만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const mode = interaction.options.getString('방식', true);
  const teamCount = interaction.options.getInteger('팀수') ?? 2;
  let thread;
  try {
    thread = await createTeamThread(interaction, mode);
  } catch (error) {
    if (error?.code === 50013) {
      await interaction.editReply('팀짜기 스레드를 만들 권한이 없습니다. 봇 역할에 공개 스레드 만들기, 비공개 스레드 만들기, 스레드 관리 권한을 추가해주세요.');
      return;
    }
    await interaction.editReply(error.message);
    return;
  }

  if (mode === 'automatic') {
    await handleAutomaticMode(interaction, thread, teamCount);
  } else {
    await handleManualMode(interaction, thread, teamCount);
  }
}
