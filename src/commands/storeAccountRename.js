import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { supabase } from '../services/supabase.js';
import { autocompleteStoreAccount } from '../services/storeAccounts.js';

export const data = new SlashCommandBuilder()
  .setName('상점계정이름변경')
  .setDescription('연동된 상점 계정의 별칭을 변경합니다.')
  .addStringOption((opt) =>
    opt
      .setName('기존계정명')
      .setDescription('현재 계정 별칭 (예: 기본계정)')
      .setRequired(true)
      .setMaxLength(32)
        .setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt
      .setName('새계정명')
      .setDescription('변경할 새 계정 별칭 (예: 본계정)')
      .setRequired(true)
      .setMaxLength(32)
  );

export async function autocomplete(interaction) {
  await autocompleteStoreAccount(interaction, '기존계정명');
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const currentName = interaction.options.getString('기존계정명').trim();
  const newName = interaction.options.getString('새계정명').trim();

  if (!currentName || !newName) {
    await interaction.editReply('계정명은 비워둘 수 없습니다.');
    return;
  }
  if (currentName === newName) {
    await interaction.editReply('기존 계정명과 새 계정명이 같습니다.');
    return;
  }

  const { data: renamedAccounts, error } = await supabase
    .from('riot_store_sessions')
    .update({ account_name: newName, updated_at: new Date().toISOString() })
    .eq('discord_id', interaction.user.id)
    .eq('account_name', currentName)
    .select('account_name');

  if (error) {
    if (error.code === '23505') {
      await interaction.editReply(`이미 **${newName}**이라는 계정명이 있습니다.`);
      return;
    }
    await interaction.editReply(`상점 계정명을 변경하지 못했습니다: ${error.message}`);
    return;
  }
  if (!renamedAccounts?.length) {
    await interaction.editReply(`연동된 계정 **${currentName}**을(를) 찾지 못했습니다.`);
    return;
  }

  await interaction.editReply(`상점 계정명을 **${currentName}**에서 **${newName}**(으)로 변경했습니다.`);
}
