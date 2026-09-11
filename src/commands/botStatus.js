import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireServerManager } from '../services/admin.js';
import { supabase } from '../services/supabase.js';

export const data = new SlashCommandBuilder()
  .setName('봇상태')
  .setDescription('봇과 주요 데이터 저장소 상태를 확인합니다.');

export async function execute(interaction) {
  const permissionError = requireServerManager(interaction);
  if (permissionError) {
    await interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const startedAt = Date.now();
  const [{ count: players, error: playerError }, { count: sessions, error: sessionError }] = await Promise.all([
    supabase.from('players').select('*', { count: 'exact', head: true }),
    supabase.from('riot_store_sessions').select('*', { count: 'exact', head: true }),
  ]);
  const databaseStatus = playerError || sessionError ? '오류' : '정상';
  const uptimeSeconds = Math.floor(process.uptime());
  const uptime = `${Math.floor(uptimeSeconds / 3600)}시간 ${Math.floor((uptimeSeconds % 3600) / 60)}분`;
  await interaction.editReply(
    `봇 운영 상태\n` +
    `응답 시간: ${Date.now() - startedAt}ms\n` +
    `실행 시간: ${uptime}\n` +
    `Supabase: ${databaseStatus}\n` +
    `등록 사용자: ${players ?? '-'}명\n` +
    `상점 세션: ${sessions ?? '-'}개\n` +
    `메모리: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`
  );
}
