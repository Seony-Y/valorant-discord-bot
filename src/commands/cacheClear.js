import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireServerManager } from '../services/admin.js';
import { supabase } from '../services/supabase.js';

export const data = new SlashCommandBuilder()
  .setName('캐시초기화')
  .setDescription('전적 파워 스코어 캐시를 전체 삭제합니다.');

export async function execute(interaction) {
  const permissionError = requireServerManager(interaction);
  if (permissionError) {
    await interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { data: deletedRows, error } = await supabase
    .from('stats_cache')
    .delete()
    .select('discord_id');
  if (error) {
    await interaction.editReply(`전적 캐시를 초기화하지 못했습니다: ${error.message}`);
    return;
  }

  await interaction.editReply(`전적 파워 스코어 캐시를 초기화했습니다. 삭제된 캐시: ${deletedRows?.length ?? 0}개`);
}
