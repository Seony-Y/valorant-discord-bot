// Imported right after dotenv so a misconfigured deploy fails at startup instead of on the first command that needs the value.
const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'HENRIK_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CREDENTIAL_ENCRYPTION_KEY',
];

const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  throw new Error(`필수 환경변수가 없습니다: ${missing.join(', ')}`);
}
if (!/^[0-9a-f]{64}$/i.test(process.env.CREDENTIAL_ENCRYPTION_KEY.trim())) {
  throw new Error('CREDENTIAL_ENCRYPTION_KEY는 64자리 hex(32바이트)여야 합니다.');
}
if (!process.env.BOT_OWNER_IDS?.trim()) {
  console.warn('BOT_OWNER_IDS가 비어 있어 운영자 전용 명령어(/봇상태, /캐시초기화)를 아무도 사용할 수 없습니다.');
}
