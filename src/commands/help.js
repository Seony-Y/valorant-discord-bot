import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('도움말')
  .setDescription('봇 기능과 명령어 사용법을 확인합니다.');

export async function execute(interaction) {
  const hero = new EmbedBuilder()
    .setTitle('Valorant Discord Bot')
    .setURL('https://naguling-valorant-discord-bot.vercel.app/')
    .setDescription('전적 조회, 팀 밸런싱, 상점 조회를 Discord에서 바로.\n\n`/도움말`에서 주요 기능과 시작 순서를 확인하세요.')
    .setColor(0xff4655)
    .addFields(
      {
        name: '주요 기능',
        value: '전적 분석 · 경기별 KDA\n공식 대회 일정 · 순위 · 결과\n상세 팀 밸런싱 결과\n다중 계정 상점 · 상태 확인 · 알림\n발로란트 공식 소식 채널',
        inline: true,
      },
      {
        name: '시작 순서',
        value: '`/계정등록` → `/전적`\n`/팀짜기`로 팀 구성\n`/상점연동 계정명:본계정` → `/상점`',
        inline: true,
      },
      {
        name: '웹사이트 바로가기',
        value: '[Valorant Discord Bot 홈페이지](https://naguling-valorant-discord-bot.vercel.app/)',
        inline: false,
      },
    )
    .setFooter({ text: 'Discord에서 바로 사용하는 Valorant 도우미' });

  const commands = new EmbedBuilder()
    .setTitle('명령어 상세 안내')
    .setDescription('아래 옵션을 함께 보면 바로 사용할 수 있습니다.')
    .setColor(0x242630)
    .addFields(
      {
        name: '`/계정등록`',
        value: 'Riot ID와 지역 등록\n필수 옵션: 이름, 태그, 지역(kr/na/eu/ap)',
        inline: false,
      },
      {
        name: '`/전적`',
        value: '본인 또는 다른 계정 전적 조회\n`/전적 경기별:TRUE` · 최근 경기 상세\n`/전적 스킬사용기록:TRUE` · 게임별 스킬 사용량과 KDA\n`/전적 이름:니코 태그:KR 지역:kr` · 다른 계정 조회\n`/전적 시즌:에피소드명` · 선택 시즌 기록',
        inline: false,
      },
      {
        name: '`/팀짜기`',
        value: '수동 또는 자동으로 팀 균형 맞춤\n결과에 개인 티어·점수와 팀별 합계·평균·점수 차이 표시\n옵션: 방식(수동/자동), 팀수(2팀/3팀)',
        inline: false,
      },
      {
        name: '`/내정보`',
        value: '등록된 Riot 계정, 상점 계정의 쿠키 상태, 기본 계정, 상점 알림 설정을 한 번에 확인합니다.',
        inline: false,
      },
      {
        name: '`/상점`',
        value: '상점 연동, 조회, 기본 계정, 계정 관리를 한 곳에서 처리합니다.\n`/상점연동 계정명:본계정` · 계정별 Riot Mobile QR 승인\n`/상점 계정명:본계정` · 선택 계정 상점 조회\n`/상점기본계정 계정명:본계정` · 계정명 없는 조회의 기본 계정 설정\n`/상점계정목록` · 연동 계정과 Riot 닉네임 및 쿠키 상태 확인\n`/상점계정정리` · 만료된 세션 삭제\n`/상점알림 설정 시:9 분:0 계정명:본계정` · 본계정 알림 설정\n`/상점알림 목록` · 계정별 알림 시간과 상태 확인\n`/상점알림 해제 계정명:부계정` · 특정 계정 해제\n`/상점알림 해제` · 전체 계정 해제',
        inline: false,
      },
      {
        name: '`/상점즐겨찾기`',
        value: '관심 스킨 등록 후 오늘의 상점을 즉시 확인합니다. 등장 중이면 계정명과 스킨명을 DM으로 보내고, 없으면 예약 상점 DM 또는 다음 날 오전 9시 갱신 확인에서 알려드립니다.\n`/상점즐겨찾기 추가 스킨명:프라임 밴달`\n`/상점즐겨찾기 일괄추가 스킨1:프라임 밴달 스킨2:오니 팬텀` · 최대 5개\n`/상점즐겨찾기 목록`\n`/상점즐겨찾기 삭제 스킨명:프라임 밴달`\n`/상점즐겨찾기 전체삭제`',
        inline: false,
      },
      {
        name: '`/소식알림` · 관리자 전용',
        value: '한국 공식 공지, 패치 노트와 신규 스킨 소식을 기존 채널 또는 새 전용 채널에 매일 자동 전송합니다. 최초 설정 시 최신 소식을 즉시 전송합니다.\n`/소식알림 설정 전송방식:선택한 기존 채널 사용 채널:#발로봇 시:9 분:0`\n`/소식알림 상태`\n`/소식알림 해제`',
        inline: false,
      },
      {
        name: '`/대회`',
        value: 'Riot 공식 한국어 데이터로 대회를 조회하며 결과는 채널에 공개됩니다.\n`/대회 일정 리그:VCT 퍼시픽`\n`/대회 순위 대회:2026 스테이지 2 단계:정규 리그`\n`/대회 결과 리그:전체`',
        inline: false,
      },
      {
        name: '상점 이동',
        value: '화살표 버튼으로 페이지를 전환합니다.',
        inline: false,
      },
    );

  const examples = new EmbedBuilder()
    .setTitle('사용 예시')
    .setDescription('자주 쓰는 조합입니다.')
    .setColor(0x3ba7ff)
    .addFields(
      {
        name: '기본 전적 확인',
        value: '`/전적`',
        inline: true,
      },
      {
        name: '다른 계정 조회',
        value: '`/전적 이름:GULING 태그:KR1 지역:kr`',
        inline: true,
      },
      {
        name: '시즌 경기 세부 분석',
        value: '`/전적 경기별:TRUE`',
        inline: true,
      },
      {
        name: '스킬 사용 기록 보기',
        value: '`/전적 스킬사용기록:TRUE`',
        inline: true,
      },
      {
        name: '팀 나누기',
        value: '`/팀짜기 방식:수동 팀수:2`',
        inline: true,
      },
      {
        name: '상점 보기',
        value: '`/상점`',
        inline: true,
      },
    );

  const notice = new EmbedBuilder()
    .setTitle('사용 팁')
    .setDescription('본인 전적 조회는 `/전적`만 실행하면 됩니다. 다른 계정 조회는 이름, 태그, 지역을 함께 넣어주세요.\n상점은 QR 로그인이 필요하며, 세션 만료 시 `/상점연동`을 다시 실행하세요.')
    .setColor(0x242630)
    .setFooter({ text: 'VALORANT Discord Bot v1.0.0 · Copyright © Na_Gu (na_guling) · 문의는 개인 DM으로 부탁드립니다.' });

  await interaction.reply({ embeds: [hero, commands, examples, notice], flags: MessageFlags.Ephemeral });
}
