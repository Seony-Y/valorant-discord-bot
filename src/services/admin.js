import { PermissionFlagsBits } from 'discord.js';

export function requireServerManager(interaction) {
  if (!interaction.guild) return '서버 안에서만 사용할 수 있는 관리자 명령어입니다.';
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return '이 명령어는 서버 관리 권한이 있는 관리자만 사용할 수 있습니다.';
  }
  return null;
}
