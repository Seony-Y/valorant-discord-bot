import { decryptCredential, restoreRiotStoreSession } from './riotAuth.js';
import { supabase } from './supabase.js';

export async function autocompleteStoreAccount(interaction, optionName = '계정명') {
  const focused = interaction.options.getString(optionName) ?? '';
  const { data: accounts, error } = await supabase
    .from('riot_store_sessions')
    .select('account_name, riot_name, riot_tag')
    .eq('discord_id', interaction.user.id)
    .ilike('account_name', `%${focused}%`)
    .order('account_name')
    .limit(25);

  if (error) {
    await interaction.respond([]);
    return;
  }

  await interaction.respond((accounts ?? []).map((account) => ({
    name: account.riot_name && account.riot_tag
      ? `${account.account_name} (${account.riot_name}#${account.riot_tag})`
      : account.account_name,
    value: account.account_name,
  })));
}

export async function getStoreAccountStatus(account) {
  try {
    const ssid = decryptCredential({ encrypted: account.encrypted_ssid, iv: account.iv, authTag: account.auth_tag });
    await restoreRiotStoreSession({ ssid, puuid: account.puuid, shard: account.shard });
    return '정상';
  } catch (error) {
    if (error?.code === 'RIOT_SESSION_EXPIRED') return '재로그인 필요';
    return '조회 실패';
  }
}
