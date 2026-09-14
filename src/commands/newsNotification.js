import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { disableNewsNotification, configureNewsNotification } from '../services/newsNotifications.js';
import { supabase } from '../services/supabase.js';

export const data = new SlashCommandBuilder()
  .setName('소식알림')
  .setDescription('발로란트 공식 소식 스레드 알림을 관리합니다.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) => subcommand
    .setName('설정')
    .setDescription('매일 공식 소식을 보낼 스레드와 시간을 설정합니다.')
    .addChannelOption((option) => option
      .setName('채널')
      .setDescription('소식 스레드를 만들 부모 텍스트 채널')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName('시')
      .setDescription('한국 시간 기준 0~23시')
      .setMinValue(0)
      .setMaxValue(23)
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName('분')
      .setDescription('0~59분')
      .setMinValue(0)
      .setMaxValue(59)
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('해제')
    .setDescription('공식 소식 자동 알림을 중지합니다.'))
  .addSubcommand((subcommand) => subcommand
    .setName('상태')
    .setDescription('현재 공식 소식 알림 설정을 확인합니다.'));

function hasAdministratorPermission(interaction) {
  return interaction.guild && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

export async function execute(interaction) {
  if (!hasAdministratorPermission(interaction)) {
    await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();

  if (action === '해제') {
    const disabled = await disableNewsNotification(interaction.guild);
    await interaction.editReply(disabled ? '발로란트 공식 소식 알림을 해제했습니다.' : '설정된 소식 알림이 없습니다.');
    return;
  }

  if (action === '상태') {
    const { data: subscription, error } = await supabase
      .from('valorant_news_subscriptions')
      .select('channel_id, thread_id, enabled, hour, minute')
      .eq('guild_id', interaction.guild.id)
      .maybeSingle();
    if (error) throw error;
    if (!subscription) {
      await interaction.editReply('설정된 소식 알림이 없습니다.');
      return;
    }
    const time = `${String(subscription.hour).padStart(2, '0')}:${String(subscription.minute).padStart(2, '0')}`;
    await interaction.editReply(
      `상태: **${subscription.enabled ? '활성화' : '비활성화'}**\n` +
      `부모 채널: <#${subscription.channel_id}>\n` +
      `소식 스레드: ${subscription.thread_id ? `<#${subscription.thread_id}>` : '없음'}\n` +
      `전송 시간: 매일 **${time} KST**`
    );
    return;
  }

  const channel = interaction.options.getChannel('채널', true);
  const hour = interaction.options.getInteger('시', true);
  const minute = interaction.options.getInteger('분', true);
  const botPermissions = channel.permissionsFor(interaction.guild.members.me);
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.EmbedLinks,
  ];
  if (!botPermissions?.has(requiredPermissions)) {
    await interaction.editReply('선택한 채널에서 봇의 채널 보기, 메시지 보내기, 임베드 링크, 공개 스레드 만들기·보내기·관리 권한을 확인해주세요.');
    return;
  }

  const thread = await configureNewsNotification(interaction.guild, channel, hour, minute);
  await interaction.editReply(
    `<#${thread.id}> 스레드에 매일 한국 시간 **${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}**부터 ` +
    '새로운 발로란트 공식 공지와 게임 업데이트를 전송합니다.'
  );
}