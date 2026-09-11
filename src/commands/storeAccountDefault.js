import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { supabase } from '../services/supabase.js';
import { autocompleteStoreAccount } from '../services/storeAccounts.js';

export const data = new SlashCommandBuilder()
  .setName('상점기본계정')
  .setDescription('계정명을 생략했을 때 조회할 기본 상점을 설정합니다.')
  .addStringOption((opt) =>
    opt
      .setName('계정명')
      .setDescription('기본으로 사용할 연동 계정명')
      .setRequired(true)
      .setMaxLength(64)
        .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  await autocompleteStoreAccount(interaction);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const accountName = interaction.options.getString('계정명').trim();

  const { data: account, error: findError } = await supabase
    .from('riot_store_sessions')
    .select('account_name, riot_name, riot_tag')
    .eq('discord_id', interaction.user.id)
    .eq('account_name', accountName)
    .maybeSingle();

  if (findError) {
    await interaction.editReply(`상점 계정을 조회하지 못했습니다: ${findError.message}`);
    return;
  }
  if (!account) {
    await interaction.editReply(`연동된 계정 **${accountName}**을(를) 찾지 못했습니다. 먼저 \/상점계정목록을 확인해주세요.`);
    return;
  }

  const { error: clearError } = await supabase
    .from('riot_store_sessions')
    .update({ is_default: false })
    .eq('discord_id', interaction.user.id);
  if (clearError) {
    await interaction.editReply(`기본 계정을 설정하지 못했습니다: ${clearError.message}`);
    return;
  }

  const { error: setError } = await supabase
    .from('riot_store_sessions')
    .update({ is_default: true })
    .eq('discord_id', interaction.user.id)
    .eq('account_name', accountName);
  if (setError) {
    await interaction.editReply(`기본 계정을 설정하지 못했습니다: ${setError.message}`);
    return;
  }

  const riotLabel = account.riot_name && account.riot_tag ? ` (${account.riot_name}#${account.riot_tag})` : '';
  await interaction.editReply(`기본 상점 계정을 **${accountName}**${riotLabel}(으)로 설정했습니다. 이제 계정명 없이 \`/상점\`을 사용할 수 있습니다.`);
}
