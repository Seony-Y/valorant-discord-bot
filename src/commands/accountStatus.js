import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { supabase } from '../services/supabase.js';
import { getStoreAccountStatus } from '../services/storeAccounts.js';

export const data = new SlashCommandBuilder()
  .setName('내정보')
  .setDescription('등록된 Riot 계정과 상점 연동 상태를 확인합니다.');

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [{ data: player, error: playerError }, { data: accounts, error: accountError }, { data: notification, error: notificationError }] = await Promise.all([
    supabase.from('players').select('riot_name, riot_tag, region, updated_at').eq('discord_id', interaction.user.id).maybeSingle(),
    supabase.from('riot_store_sessions').select('account_name, is_default, riot_name, riot_tag, encrypted_ssid, iv, auth_tag, puuid, shard').eq('discord_id', interaction.user.id).order('updated_at', { ascending: false }),
    supabase.from('store_notifications').select('enabled, hour, minute, account_name').eq('discord_id', interaction.user.id).maybeSingle(),
  ]);

  if (playerError || accountError) {
    await interaction.editReply(`계정 상태를 조회하지 못했습니다: ${(playerError ?? accountError).message}`);
    return;
  }

  const lines = [];
  if (player) {
    lines.push(`Riot 계정: **${player.riot_name}#${player.riot_tag}** (${player.region.toUpperCase()})`);
  } else {
    lines.push('Riot 계정: 미등록 · `/계정등록` 필요');
  }

  if (accounts?.length) {
    const accountLines = await Promise.all(accounts.map(async (account) => {
      const status = await getStoreAccountStatus(account);
      const defaultLabel = account.is_default ? ' · 기본' : '';
      const riotLabel = account.riot_name && account.riot_tag ? ` · ${account.riot_name}#${account.riot_tag}` : '';
      return `- **${account.account_name}**${riotLabel}${defaultLabel} · ${status}`;
    }));
    lines.push(`상점 계정:\n${accountLines.join('\n')}`);
  } else {
    lines.push('상점 계정: 미연동 · `/상점연동` 필요');
  }

  if (notificationError && notificationError.code !== '42P01') {
    lines.push(`상점 알림: 조회 실패 (${notificationError.message})`);
  } else if (notification?.enabled) {
    const accountLabel = notification.account_name ?? '기본 계정';
    lines.push(`상점 알림: 활성화 · 매일 ${String(notification.hour).padStart(2, '0')}:${String(notification.minute).padStart(2, '0')} · ${accountLabel}`);
  } else {
    lines.push('상점 알림: 비활성화');
  }

  await interaction.editReply(`내 계정 상태\n${lines.join('\n')}`);
}
