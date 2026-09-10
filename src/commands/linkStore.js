import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import QRCode from 'qrcode';
import { checkRiotQrLogin, getRiotDisplayName, startRiotQrLogin } from '../services/riotAuth.js';
import { supabase } from '../services/supabase.js';
import { saveStoreSession } from './store.js';

export const data = new SlashCommandBuilder()
  .setName('상점연동')
  .setDescription('Riot Mobile QR 로그인으로 상점 조회를 활성화합니다.')
  .addStringOption((opt) =>
    opt
      .setName('계정명')
      .setDescription('저장할 계정 이름 (예: 본계정, 부계정)')
      .setRequired(false)
      .setMaxLength(32)
  );

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const explicitAccountName = interaction.options.getString('계정명')?.trim() || null;
  const requestedAccountName = explicitAccountName ?? '기본계정';

  const { data: player } = await supabase
    .from('players')
    .select('discord_id')
    .eq('discord_id', interaction.user.id)
    .single();

  if (!player) {
    await interaction.editReply('먼저 `/계정등록`으로 Riot ID를 등록해주세요.');
    return;
  }

  try {
    const qrLogin = await startRiotQrLogin();
    const image = await QRCode.toBuffer(qrLogin.loginUrl, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
    const attachment = new AttachmentBuilder(image, { name: 'riot-login.png' });
    await interaction.editReply({
      content: 'Riot Mobile 앱에서 아래 QR 이미지를 스캔하고 로그인을 승인해주세요.\n' +
        `QR이 보이지 않으면 [Riot Mobile 로그인 열기](${qrLogin.loginUrl})를 누르세요.\n` +
        '이 QR은 5분 후 만료됩니다.',
      files: [attachment],
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(3000);
      const session = await checkRiotQrLogin(qrLogin.id);
      if (!session) continue;
      let displayName = null;
      try {
        displayName = await getRiotDisplayName(session);
      } catch (error) {
        console.warn(`Riot 닉네임 조회 실패: ${error.message}`);
      }

      let accountName = requestedAccountName;
      if (!explicitAccountName) {
        // 계정명을 지정하지 않았다면 같은 Riot 계정(puuid)의 기존 연동 기록을 갱신해 중복 저장을 막는다.
        const { data: existing } = await supabase
          .from('riot_store_sessions')
          .select('account_name')
          .eq('discord_id', interaction.user.id)
          .eq('puuid', session.puuid)
          .maybeSingle();
        if (existing) {
          accountName = existing.account_name;
        } else if (displayName) {
          accountName = `${displayName.riotName}#${displayName.riotTag}`;
        }
      }
      await saveStoreSession(interaction.user.id, accountName, { ...session, ...(displayName ?? {}) });
      const riotLabel = displayName ? ` (${displayName.riotName}#${displayName.riotTag})` : '';
      await interaction.editReply(`Riot Mobile 로그인이 완료되었습니다${riotLabel}. 이제 /상점 계정명:${accountName} 으로 오늘의 상점을 조회할 수 있습니다.`);
      return;
    }
  } catch (err) {
    await interaction.editReply(`QR 로그인에 실패했습니다: ${err.message}`);
  }
}
