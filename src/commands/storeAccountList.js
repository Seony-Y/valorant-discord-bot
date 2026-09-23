import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getRiotDisplayName } from '../services/riotAuth.js';
import { supabase } from '../services/supabase.js';
import { getStoreAccountStatus, restoreStoreAccountSession } from '../services/storeAccounts.js';

export const data = new SlashCommandBuilder()
  .setName('상점계정목록')
  .setDescription('내 상점에 연동된 Riot 계정 목록을 확인합니다.');

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { data: accounts, error } = await supabase
    .from('riot_store_sessions')
    .select('account_name, is_default, riot_name, riot_tag, encrypted_ssid, iv, auth_tag, puuid, shard, updated_at')
    .eq('discord_id', interaction.user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    await interaction.editReply(`상점 계정 목록을 조회하지 못했습니다: ${error.message}`);
    return;
  }

  if (!accounts?.length) {
    await interaction.editReply('연동된 상점 계정이 없습니다. `/상점연동`을 사용해주세요.');
    return;
  }

  const resolvedAccounts = await Promise.all(accounts.map(async (account) => {
    if (!account.riot_name || !account.riot_tag) {
      try {
        const session = await restoreStoreAccountSession(interaction.user.id, account);
        const displayName = await getRiotDisplayName(session);
        if (!displayName) return { ...account, status: '정상' };

        let accountName = account.account_name;
        if (accountName === '기본계정') accountName = `${displayName.riotName}#${displayName.riotTag}`;
        const { error: updateError } = await supabase
          .from('riot_store_sessions')
          .update({ account_name: accountName, riot_name: displayName.riotName, riot_tag: displayName.riotTag })
          .eq('discord_id', interaction.user.id)
          .eq('account_name', account.account_name);
        return { ...account, ...displayName, status: '정상', account_name: updateError ? account.account_name : accountName };
      } catch (error) {
        console.warn(`상점 계정 닉네임 조회 실패 (${account.account_name}): ${error.message}`);
        const status = error.code === 'RIOT_SESSION_EXPIRED'
          ? '재로그인 필요'
          : error.code === 'RIOT_SERVICE_UNAVAILABLE' ? 'Riot 서버 점검 중' : '조회 실패';
        return { ...account, status };
      }
    }

    const status = await getStoreAccountStatus(interaction.user.id, account);
    return { ...account, status };
  }));

  const lines = resolvedAccounts
    .map((account, index) => {
      const updatedAt = new Intl.DateTimeFormat('ko-KR', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Seoul',
      }).format(new Date(account.updated_at));
      const riotLabel = account.riot_name && account.riot_tag ? ` · ${account.riot_name}#${account.riot_tag}` : '';
      const defaultLabel = account.is_default ? ' · 기본' : '';
      return `${index + 1}. **${account.account_name}**${riotLabel}${defaultLabel} · 상태: ${account.status} · 최근 연동 ${updatedAt}`;
    })
    .join('\n');

  await interaction.editReply(`연동된 상점 계정\n${lines}\n\n조회: /상점 계정명:계정명\n재로그인: /상점연동 계정명:계정명\n정리: /상점계정정리`);
}
