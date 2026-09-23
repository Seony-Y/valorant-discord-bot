import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { supabase } from '../services/supabase.js';
import { autocompleteStoreAccount, getStoreAccountStatus } from '../services/storeAccounts.js';

export const data = new SlashCommandBuilder()
  .setName('상점계정정리')
  .setDescription('쿠키가 만료된 상점 계정을 삭제합니다.')
  .addStringOption((opt) =>
    opt
      .setName('계정명')
      .setDescription('비우면 만료된 계정을 모두 삭제합니다.')
      .setRequired(false)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  await autocompleteStoreAccount(interaction);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const accountName = interaction.options.getString('계정명')?.trim();
  const { data: accounts, error } = await supabase
    .from('riot_store_sessions')
    .select('account_name, encrypted_ssid, iv, auth_tag, puuid, shard')
    .eq('discord_id', interaction.user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    await interaction.editReply(`상점 계정을 조회하지 못했습니다: ${error.message}`);
    return;
  }

  const targets = accountName
    ? (accounts ?? []).filter((account) => account.account_name === accountName)
    : (accounts ?? []);
  if (!targets.length) {
    await interaction.editReply(accountName
      ? `연동된 계정 **${accountName}**을(를) 찾지 못했습니다.`
      : '정리할 상점 계정이 없습니다.');
    return;
  }

  const statuses = await Promise.all(targets.map(async (account) => ({
    account,
    status: await getStoreAccountStatus(interaction.user.id, account),
  })));
  const expired = statuses.filter(({ status }) => status === '재로그인 필요');
  const unavailable = statuses.filter(({ status }) => status === 'Riot 서버 점검 중');
  if (!expired.length) {
    if (unavailable.length) {
      await interaction.editReply('Riot 서버 점검 중이라 계정 만료 여부를 확인하지 못했습니다. 계정을 삭제하지 않았습니다.');
      return;
    }
    await interaction.editReply(accountName
      ? `**${accountName}** 계정은 아직 정상 상태입니다. 삭제하지 않았습니다.`
      : '쿠키가 만료된 계정이 없습니다. 삭제하지 않았습니다.');
    return;
  }

  const { error: deleteError } = await supabase
    .from('riot_store_sessions')
    .delete()
    .eq('discord_id', interaction.user.id)
    .in('account_name', expired.map(({ account }) => account.account_name));
  if (deleteError) {
    await interaction.editReply(`만료된 계정을 삭제하지 못했습니다: ${deleteError.message}`);
    return;
  }

  const names = expired.map(({ account }) => `**${account.account_name}**`).join(', ');
  const unavailableMessage = unavailable.length
    ? '\n점검 중이라 확인하지 못한 계정은 삭제하지 않았습니다.'
    : '';
  await interaction.editReply(`쿠키가 만료된 상점 계정을 삭제했습니다: ${names}${unavailableMessage}`);
}