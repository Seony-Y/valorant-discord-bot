import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireBotOwner } from '../services/admin.js';
import { supabase } from '../services/supabase.js';
import { getUnresolvedBundles, invalidateBundleOverrides } from '../services/valorantAssets.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const data = new SlashCommandBuilder()
  .setName('번들정보')
  .setDescription('valorant-api.com에 아직 없는 신규 번들의 이름/이미지를 직접 지정합니다 (봇 운영자 전용).')
  .addSubcommand((subcommand) => subcommand
    .setName('미확인목록')
    .setDescription('상점 조회 중 정보를 찾지 못한 번들 ID를 확인합니다.'))
  .addSubcommand((subcommand) => subcommand
    .setName('설정')
    .setDescription('번들 이름과 이미지를 지정합니다.')
    .addStringOption((option) => option
      .setName('번들id')
      .setDescription('번들 ID (DataAssetID, 미확인목록에서 확인)')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('이름')
      .setDescription('표시할 번들 이름')
      .setRequired(true)
      .setMaxLength(100))
    .addStringOption((option) => option
      .setName('이미지url')
      .setDescription('번들 이미지 URL (https://...)')
      .setRequired(false)))
  .addSubcommand((subcommand) => subcommand
    .setName('삭제')
    .setDescription('직접 지정한 번들 정보를 삭제합니다.')
    .addStringOption((option) => option
      .setName('번들id')
      .setDescription('삭제할 번들 ID')
      .setRequired(true)
      .setAutocomplete(true)));

export async function autocomplete(interaction) {
  if (requireBotOwner(interaction)) {
    await interaction.respond([]);
    return;
  }
  const query = interaction.options.getFocused().toLowerCase();
  let choices;
  if (interaction.options.getSubcommand() === '삭제') {
    const { data: rows } = await supabase.from('bundle_overrides').select('bundle_id, name').order('updated_at', { ascending: false });
    choices = (rows ?? []).map((row) => ({ id: row.bundle_id, label: row.name }));
  } else {
    choices = getUnresolvedBundles().map((bundle) => ({ id: bundle.bundleId, label: bundle.itemNames[0] ?? '구성품 미확인' }));
  }
  await interaction.respond(choices
    .filter(({ id, label }) => id.toLowerCase().includes(query) || label.toLowerCase().includes(query))
    .slice(0, 25)
    .map(({ id, label }) => ({ name: `${label} · ${id}`.slice(0, 100), value: id })));
}

export async function execute(interaction) {
  const permissionError = requireBotOwner(interaction);
  if (permissionError) {
    await interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();

  if (action === '미확인목록') {
    const bundles = getUnresolvedBundles();
    if (!bundles.length) {
      await interaction.editReply('봇이 실행된 뒤 정보를 찾지 못한 번들이 없습니다.');
      return;
    }
    await interaction.editReply(
      `정보를 찾지 못한 번들 (봇 재시작 시 초기화)\n${bundles.slice(0, 15).map((bundle) =>
        `• \`${bundle.bundleId}\`${bundle.itemNames.length ? ` — 구성품: ${bundle.itemNames.slice(0, 4).join(', ')}` : ''}`).join('\n')}`
    );
    return;
  }

  const bundleId = interaction.options.getString('번들id').trim().toLowerCase();
  if (!UUID_PATTERN.test(bundleId)) {
    await interaction.editReply('번들 ID 형식이 올바르지 않습니다. `/번들정보 미확인목록`에서 ID를 확인해주세요.');
    return;
  }

  if (action === '삭제') {
    const { data: deleted, error } = await supabase.from('bundle_overrides').delete().eq('bundle_id', bundleId).select('bundle_id');
    if (error) {
      await interaction.editReply(`번들 정보를 삭제하지 못했습니다: ${error.message}`);
      return;
    }
    invalidateBundleOverrides();
    await interaction.editReply(deleted?.length ? '번들 정보를 삭제했습니다.' : '지정된 번들 정보가 없습니다.');
    return;
  }

  const name = interaction.options.getString('이름').trim();
  const imageUrl = interaction.options.getString('이미지url')?.trim() || null;
  if (imageUrl && !/^https:\/\/\S+$/i.test(imageUrl)) {
    await interaction.editReply('이미지 URL은 https:// 로 시작해야 합니다.');
    return;
  }
  const { error } = await supabase.from('bundle_overrides').upsert({
    bundle_id: bundleId,
    name,
    image_url: imageUrl,
    updated_by: interaction.user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'bundle_id' });
  if (error) {
    await interaction.editReply(error.code === 'PGRST205' || error.code === '42P01'
      ? '`bundle_overrides` 테이블이 없습니다. `sql/bundle_overrides_and_favorite_ids.sql`을 먼저 적용해주세요.'
      : `번들 정보를 저장하지 못했습니다: ${error.message}`);
    return;
  }
  invalidateBundleOverrides();
  await interaction.editReply(`번들 정보를 저장했습니다: **${name}**${imageUrl ? ' (이미지 포함)' : ''}\nvalorant-api.com에 번들이 추가된 뒤에도 이 이름/이미지가 우선 적용됩니다.`);
}
