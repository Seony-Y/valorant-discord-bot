import { PermissionFlagsBits } from 'discord.js';

const botOwnerIds = new Set(
  (process.env.BOT_OWNER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
);

export function requireServerManager(interaction) {
  if (!interaction.guild) return '서버 안에서만 사용할 수 있는 관리자 명령어입니다.';
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return '이 명령어는 서버 관리 권한이 있는 관리자만 사용할 수 있습니다.';
  }
  return null;
}

// For commands that touch data shared by every server the bot is in; a single guild's admin must not control those.
export function requireBotOwner(interaction) {
  if (!botOwnerIds.has(interaction.user.id)) return '이 명령어는 봇 운영자만 사용할 수 있습니다.';
  return null;
}
