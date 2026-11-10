import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireBotOwner } from '../services/admin.js';
import { supabase } from '../services/supabase.js';
import { clearValorantAssetsCache } from '../services/valorantAssets.js';

export const data = new SlashCommandBuilder()
  .setName('캐시초기화')
  .setDescription('전적 파워 스코어 캐시 또는 상점 메타데이터 캐시를 초기화합니다.')
  .addStringOption((opt) =>
    opt
      .setName('대상')
      .setDescription('초기화할 캐시 (기본: 전적)')
      .setRequired(false)
      .addChoices(
        { name: '전적 파워 스코어', value: 'stats' },
        { name: '상점 메타데이터 (번들/스킨 이름·이미지)', value: 'store' },
        { name: '전체', value: 'all' },
      )
  );

export async function execute(interaction) {
  const permissionError = requireBotOwner(interaction);
  if (permissionError) {
    await interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const target = interaction.options.getString('대상') ?? 'stats';
  const lines = [];

  if (target === 'store' || target === 'all') {
    clearValorantAssetsCache();
    lines.push('상점 메타데이터 캐시를 초기화했습니다. 다음 상점 조회 때 valorant-api.com에서 새로 받아옵니다.');
  }

  if (target === 'stats' || target === 'all') {
    // PostgREST rejects an unfiltered DELETE, so match every row explicitly.
    const { data: deletedRows, error } = await supabase
      .from('stats_cache')
      .delete()
      .not('discord_id', 'is', null)
      .select('discord_id');
    if (error) {
      lines.push(`전적 캐시를 초기화하지 못했습니다: ${error.message}`);
    } else {
      lines.push(`전적 파워 스코어 캐시를 초기화했습니다. 삭제된 캐시: ${deletedRows?.length ?? 0}개`);
    }
  }

  await interaction.editReply(lines.join('\n'));
}
