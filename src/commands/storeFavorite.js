import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { searchWeaponSkins } from '../services/riotAuth.js';
import { supabase } from '../services/supabase.js';

export const data = new SlashCommandBuilder()
  .setName('상점즐겨찾기')
  .setDescription('관심 있는 스킨을 등록하고 상점 등장 여부를 확인합니다.')
  .addSubcommand((subcommand) => subcommand
    .setName('추가')
    .setDescription('관심 스킨을 즐겨찾기에 추가합니다.')
    .addStringOption((option) => option
      .setName('스킨명')
      .setDescription('추가할 스킨 이름')
      .setRequired(true)
      .setAutocomplete(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('목록')
    .setDescription('등록한 즐겨찾기 스킨을 확인합니다.'))
  .addSubcommand((subcommand) => subcommand
    .setName('전체삭제')
    .setDescription('등록한 즐겨찾기 스킨을 모두 삭제합니다.'))
  .addSubcommand((subcommand) => subcommand
    .setName('삭제')
    .setDescription('즐겨찾기에서 스킨을 삭제합니다.')
    .addStringOption((option) => option
      .setName('스킨명')
      .setDescription('삭제할 스킨 이름')
      .setRequired(true)
      .setAutocomplete(true)))
  .addSubcommand((subcommand) => {
    subcommand
      .setName('일괄추가')
      .setDescription('여러 관심 스킨을 한 번에 추가합니다.');
    for (let index = 1; index <= 5; index += 1) {
      subcommand.addStringOption((option) => option
        .setName(`스킨${index}`)
        .setDescription(`추가할 스킨 ${index} (선택)`)
        .setRequired(false)
        .setAutocomplete(true));
    }
    return subcommand;
  });

async function getFavorites(userId) {
  return supabase
    .from('store_favorites')
    .select('item_name, image_url, created_at')
    .eq('discord_id', userId)
    .order('item_name');
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = focused.value ?? '';
  const action = interaction.options.getSubcommand();
  if (action === '삭제') {
    const { data } = await getFavorites(interaction.user.id);
    const normalizedQuery = query.toLocaleLowerCase('ko-KR');
    await interaction.respond((data ?? [])
      .filter((favorite) => favorite.item_name.toLocaleLowerCase('ko-KR').includes(normalizedQuery))
      .slice(0, 25)
      .map((favorite) => ({ name: favorite.item_name, value: favorite.item_name })));
    return;
  }

  const skins = await searchWeaponSkins(query);
  await interaction.respond(skins.map((skin) => ({ name: skin.name, value: skin.name })));
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();

  if (action === '목록') {
    const { data: favorites, error } = await getFavorites(interaction.user.id);
    if (error) {
      await interaction.editReply('즐겨찾기를 조회하지 못했습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    if (!favorites?.length) {
      await interaction.editReply('등록된 즐겨찾기 스킨이 없습니다. `/상점즐겨찾기 추가`를 사용해주세요.');
      return;
    }
    await interaction.editReply(`상점 즐겨찾기\n${favorites.map((favorite, index) => `${index + 1}. **${favorite.item_name}**`).join('\n')}`);
    return;
  }

  if (action === '전체삭제') {
    const { data: deleted, error } = await supabase
      .from('store_favorites')
      .delete()
      .eq('discord_id', interaction.user.id)
      .select('item_name');
    if (error) {
      await interaction.editReply('즐겨찾기를 전체 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    await interaction.editReply(deleted?.length
      ? `즐겨찾기 ${deleted.length}개를 모두 삭제했습니다.`
      : '삭제할 즐겨찾기 스킨이 없습니다.');
    return;
  }

  if (action === '일괄추가') {
    const requestedNames = Array.from({ length: 5 }, (_, index) => interaction.options.getString(`스킨${index + 1}`)?.trim())
      .filter(Boolean);
    if (!requestedNames.length) {
      await interaction.editReply('추가할 스킨을 하나 이상 선택해주세요.');
      return;
    }

    let skins;
    try {
      skins = await Promise.all(requestedNames.map(async (itemName) => {
        const results = await searchWeaponSkins(itemName);
        const normalizedName = itemName.toLocaleLowerCase('ko-KR');
        return results.find((skin) => skin.name.toLocaleLowerCase('ko-KR') === normalizedName) ?? null;
      }));
    } catch {
      await interaction.editReply('Riot 스킨 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    const matched = skins.filter(Boolean);
    const unmatched = requestedNames.filter((_, index) => !skins[index]);
    if (matched.length) {
      const { error } = await supabase.from('store_favorites').upsert(
        matched.map((skin) => ({
          discord_id: interaction.user.id,
          item_name: skin.name,
          image_url: skin.image,
        })),
        { onConflict: 'discord_id,item_name' }
      );
      if (error) {
        await interaction.editReply('즐겨찾기를 일괄 추가하지 못했습니다. 잠시 후 다시 시도해주세요.');
        return;
      }
    }

    const lines = [`즐겨찾기 ${matched.length}개를 추가했습니다.`];
    if (matched.length) lines.push(`추가됨: ${matched.map((skin) => `**${skin.name}**`).join(', ')}`);
    if (unmatched.length) lines.push(`찾지 못함: ${unmatched.map((name) => `**${name}**`).join(', ')}`);
    await interaction.editReply(lines.join('\n'));
    return;
  }

  const itemName = interaction.options.getString('스킨명').trim();
  let skins;
  try {
    skins = await searchWeaponSkins(itemName);
  } catch {
    await interaction.editReply('Riot 스킨 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    return;
  }
  const skin = skins.find((entry) => entry.name.toLocaleLowerCase('ko-KR') === itemName.toLocaleLowerCase('ko-KR')) ?? skins[0];
  if (!skin) {
    await interaction.editReply(`**${itemName}** 스킨을 찾지 못했습니다. 자동완성 목록에서 선택해주세요.`);
    return;
  }

  if (action === '추가') {
    const { error } = await supabase.from('store_favorites').upsert({
      discord_id: interaction.user.id,
      item_name: skin.name,
      image_url: skin.image,
    }, { onConflict: 'discord_id,item_name' });
    if (error) {
      await interaction.editReply('즐겨찾기를 추가하지 못했습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    await interaction.editReply(`**${skin.name}**을(를) 상점 즐겨찾기에 추가했습니다.`);
    return;
  }

  const { data: deleted, error } = await supabase
    .from('store_favorites')
    .delete()
    .eq('discord_id', interaction.user.id)
    .eq('item_name', skin.name)
    .select('item_name');
  if (error) {
    await interaction.editReply('즐겨찾기를 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.');
    return;
  }
  await interaction.editReply(deleted?.length
    ? `**${skin.name}**을(를) 상점 즐겨찾기에서 삭제했습니다.`
    : `**${skin.name}**은(는) 즐겨찾기에 없습니다.`);
}