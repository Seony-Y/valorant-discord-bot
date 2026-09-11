import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { supabase } from '../services/supabase.js';
import { autocompleteStoreAccount } from '../services/storeAccounts.js';

export const data = new SlashCommandBuilder()
  .setName('상점계정삭제')
  .setDescription('연동된 상점 계정을 삭제합니다.')
  .addStringOption((opt) =>
    opt
      .setName('계정명')
      .setDescription('삭제할 계정 이름')
      .setRequired(true)
      .setMaxLength(32)
        .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  await autocompleteStoreAccount(interaction);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const accountName = interaction.options.getString('계정명').trim();

  const { data: deletedAccounts, error } = await supabase
    .from('riot_store_sessions')
    .delete()
    .eq('discord_id', interaction.user.id)
    .eq('account_name', accountName)
    .select('account_name');

  if (error) {
    await interaction.editReply(`상점 계정을 삭제하지 못했습니다: ${error.message}`);
    return;
  }
  if (!deletedAccounts?.length) {
    await interaction.editReply(`연동된 계정 **${accountName}**을(를) 찾지 못했습니다.`);
    return;
  }

  await interaction.editReply(`상점 계정 **${accountName}**을(를) 삭제했습니다.`);
}
