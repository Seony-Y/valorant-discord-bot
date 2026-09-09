import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getAccount } from '../services/henrik.js';
import { supabase } from '../services/supabase.js';

export const data = new SlashCommandBuilder()
  .setName('계정등록')
  .setDescription('발로란트 Riot ID를 디스코드 계정에 연결합니다.')
  .addStringOption((opt) => opt.setName('이름').setDescription('Riot 이름 (# 앞부분)').setRequired(true))
  .addStringOption((opt) => opt.setName('태그').setDescription('Riot 태그 (# 뒷부분, # 제외)').setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName('지역')
      .setDescription('서버 지역')
      .setRequired(true)
      .addChoices(
        { name: '한국/아시아 (kr)', value: 'kr' },
        { name: '북미 (na)', value: 'na' },
        { name: '유럽 (eu)', value: 'eu' },
        { name: '아시아태평양 (ap)', value: 'ap' }
      )
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = interaction.options.getString('이름');
  const tag = interaction.options.getString('태그');
  const region = interaction.options.getString('지역');

  try {
    const account = await getAccount(name, tag);
    const { error } = await supabase.from('players').upsert({
      discord_id: interaction.user.id,
      riot_name: name,
      riot_tag: tag,
      region,
      puuid: account.puuid,
    });
    if (error) throw error;

    const embed = new EmbedBuilder()
      .setTitle('계정 등록 완료')
      .setDescription(`**${name}#${tag}** (${region.toUpperCase()}) 계정이 등록되었습니다.`)
      .setColor(0x3ba7ff);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(`등록에 실패했습니다: ${err.message}`);
  }
}
