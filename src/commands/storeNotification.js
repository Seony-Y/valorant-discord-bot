import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { supabase } from '../services/supabase.js';
import { autocompleteStoreAccount } from '../services/storeAccounts.js';

export const data = new SlashCommandBuilder()
  .setName('상점알림')
  .setDescription('매일 상점 알림을 설정하거나 해제합니다.')
  .addSubcommand((subcommand) => subcommand
    .setName('설정')
    .setDescription('매일 지정한 시간에 상점을 DM으로 받습니다.')
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
      .setRequired(true))
    .addStringOption((option) => option
      .setName('계정명')
      .setDescription('알림을 받을 상점 계정 (미지정 시 기본 계정)')
      .setAutocomplete(true)
      .setRequired(false)))
  .addSubcommand((subcommand) => subcommand
    .setName('해제')
    .setDescription('상점 알림을 해제합니다.')
    .addStringOption((option) => option
      .setName('계정명')
      .setDescription('특정 계정만 해제 (미지정 시 전체 해제)')
      .setAutocomplete(true)
      .setRequired(false)));

export async function autocomplete(interaction) {
  await autocompleteStoreAccount(interaction);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();

  if (action === '해제') {
    const accountName = interaction.options.getString('계정명')?.trim() ?? null;
    let disableQuery = supabase
      .from('store_notifications')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('discord_id', interaction.user.id);
    if (accountName) disableQuery = disableQuery.eq('account_name', accountName);
    const { data: disabledRows, error } = await disableQuery.select('account_name');
    if (error) {
      await interaction.editReply(`상점 알림을 해제하지 못했습니다: ${error.message}`);
      return;
    }
    if (!disabledRows?.length) {
      await interaction.editReply(accountName
        ? `**${accountName}** 계정의 활성화된 상점 알림을 찾지 못했습니다.`
        : '활성화된 상점 알림이 없습니다.');
      return;
    }
    await interaction.editReply(accountName
      ? `**${accountName}** 계정의 상점 알림을 해제했습니다.`
      : `상점 알림 ${disabledRows.length}개를 모두 해제했습니다.`);
    return;
  }

  const hour = interaction.options.getInteger('시');
  const minute = interaction.options.getInteger('분');
  const accountName = interaction.options.getString('계정명')?.trim() ?? null;
  const { data: account, error: accountError } = await supabase
    .from('riot_store_sessions')
    .select('account_name')
    .eq('discord_id', interaction.user.id)
    .eq(accountName ? 'account_name' : 'is_default', accountName ?? true)
    .maybeSingle();

  if (accountError || !account) {
    await interaction.editReply(accountError
      ? `상점 계정을 확인하지 못했습니다: ${accountError.message}`
      : '알림에 사용할 상점 계정을 찾지 못했습니다. 먼저 `/상점연동`을 실행해주세요.');
    return;
  }

  const { error } = await supabase
    .from('store_notifications')
    .upsert({
      discord_id: interaction.user.id,
      account_name: account.account_name,
      hour,
      minute,
      enabled: true,
      last_sent_on: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'discord_id,account_name' });
  if (error) {
    await interaction.editReply(`상점 알림을 설정하지 못했습니다: ${error.message}`);
    return;
  }

  await interaction.editReply(`상점 알림을 설정했습니다. 매일 한국 시간 **${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}**에 **${account.account_name}** 계정의 상점을 DM으로 보내드립니다.`);
}
