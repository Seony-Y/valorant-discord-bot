import { decryptCredential, encryptCredential, restoreRiotStoreSession } from './riotAuth.js';
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

export async function getStoreAccountStatus(discordId, account) {
  try {
    const ssid = decryptCredential({ encrypted: account.encrypted_ssid, iv: account.iv, authTag: account.auth_tag });
    const session = await restoreRiotStoreSession({ ssid, puuid: account.puuid, shard: account.shard });
    await persistRotatedSsid(discordId, account.account_name, session);
    return '정상';
  } catch (error) {
    if (error?.code === 'RIOT_SESSION_EXPIRED') return '재로그인 필요';
    return '조회 실패';
  }
}

// Riot rotates the ssid cookie on every reauth; without saving it back, sessions expire far sooner than intended.
export async function persistRotatedSsid(discordId, accountName, session) {
  if (!session?.rotatedSsid) return;
  const encrypted = encryptCredential(session.rotatedSsid);
  await supabase
    .from('riot_store_sessions')
    .update({
      encrypted_ssid: encrypted.encrypted,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      updated_at: new Date().toISOString(),
    })
    .eq('discord_id', discordId)
    .eq('account_name', accountName);
}
