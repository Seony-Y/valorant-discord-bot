# Valorant Discord Bot

발로란트 상점/전적/티어 조회 + 밸런스 팀 매칭 디스코드 봇.

간단한 기능 소개 페이지는 [docs/index.html](docs/index.html)에서 열 수 있습니다.

## 기능

- `/계정등록` — Riot ID(이름#태그)를 디스코드 계정에 연결
- `/내정보` — 등록된 Riot 계정, 상점 계정 상태, 상점 알림 설정을 한 번에 확인
- `/전적` — 본인은 등록 계정으로 조회하고, 다른 계정은 Riot 이름·태그·지역을 직접 입력해 경쟁전·일반게임 최근 10경기 기준 KDA, KD, 승률, ACS, ADR, 헤드샷 비율, 최근 캐릭터 TOP5, 총기별 킬 TOP5, 맵별 승률, 경기별 기록, 현재/최고 티어를 조회합니다. `시즌`을 선택하면 최근 100경기를 페이지별로 조회해 해당 시즌의 경쟁전·일반게임 기록을 표시합니다.
- `/상점연동` — Riot Mobile QR 로그인으로 상점 조회를 연결합니다 (비공식 방식)
- `/상점` — 오늘의 상점, 장식 상점, 상점 번들을 화살표로 전환해 조회
- `/상점계정목록` — 연동 계정의 쿠키 상태(정상/재로그인 필요)를 확인
- `/상점계정정리` — 쿠키가 만료된 상점 계정을 삭제
- `/상점알림 설정` — 매일 지정한 한국 시간에 선택한 상점 계정을 DM으로 알림
- `/상점알림 해제` — 상점 알림 중지
- `/팀짜기` — 티켓처럼 열리는 스레드에서 수동 버튼 참가 또는 Riot 이름·태그 직접 입력으로 파워 스코어 기준 2팀 또는 3팀을 분배합니다. 결과에 개인 티어·점수, 팀별 합계·평균·점수 차이를 표시합니다.

`/팀짜기` 사용 방식:

- `팀수` — 2팀 또는 3팀을 선택합니다. 선택하지 않으면 2팀이 기본값입니다.
- `방식: 수동` — 공개 스레드에서 참가자들이 `참가` 버튼을 누릅니다. 최대 15명까지 참가할 수 있습니다.
- `방식: 자동` — 주최자와 봇만 볼 수 있는 비공개 스레드가 생성됩니다. `계정 추가`를 누르면 팝업에서 해당 계정의 서버를 선택하고 Riot 이름·태그를 함께 입력합니다. 기본 서버는 `kr`이며, 최대 15명까지 등록한 뒤 `팀 나누기`를 누릅니다.
- 자동 방식은 팀 밸런싱에 필요한 KDA, ACS, 현재/최고 티어만 한 명씩 조회해 API 요청과 계산량을 줄입니다. 결과 스레드는 10분 후 삭제됩니다. 모집 중에는 사용자 메시지나 버튼 활동이 10분 동안 없을 때만 스레드가 만료되고 삭제됩니다.

## 사전 준비

1. **Discord 봇**: [Discord Developer Portal](https://discord.com/developers/applications)에서 애플리케이션 생성 → Bot 토큰 발급, `applications.commands` + `bot` 스코프로 서버 초대.
2. **HenrikDev API 키**: [HenrikDev API](https://docs.henrikdev.xyz)에서 무료 키 신청 (전적/랭크/계정 조회용).
3. **Supabase 프로젝트**: [Supabase](https://supabase.com)에서 프로젝트 생성 후 `sql/schema.sql`을 SQL Editor에서 실행. `Project Settings > API`에서 URL과 `service_role` 키 확인.
4. **자격 증명 암호화 키**: 아래 명령으로 32바이트 키 생성.

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

## 설치 및 실행

```powershell
npm install
Copy-Item .env.example .env
# .env 파일을 열어 DISCORD_TOKEN, DISCORD_CLIENT_ID, HENRIK_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIAL_ENCRYPTION_KEY 채우기
npm run deploy   # 슬래시 명령어를 글로벌 등록 (여러 서버에서 사용)
npm start        # 봇 실행
```

글로벌 명령어는 Discord 반영까지 시간이 걸릴 수 있습니다. 봇을 사용하려는 각 서버에 `bot` 및 `applications.commands` 스코프로 초대하면 동일한 명령어를 사용할 수 있습니다.

## ⚠️ `/상점`, `/상점연동` 관련 주의사항

- Riot 공식 API는 타인의 상점을 조회할 방법을 제공하지 않습니다. 이 기능은 Riot Client QR 로그인 흐름을 사용하는 **비공식 방식**입니다.
- `/상점연동`은 Riot Mobile 앱으로 QR을 스캔해 승인합니다. QR 대기 세션은 5분 후 만료되며, Riot 아이디·비밀번호·이메일 인증 코드를 봇에 입력하지 않습니다.
- 재인증용 Riot 세션 쿠키는 AES-256-GCM으로 암호화되어 Supabase에 저장됩니다. 세션이 만료되거나 Riot이 무효화하면 `/상점연동`으로 다시 QR 로그인해야 합니다.

## 팀 매칭 점수 산정 방식

`src/services/scoring.js`의 `computePowerScore`는 ACS와 KDA를 중심으로 파워 스코어를 계산합니다.

티어 데이터가 있으면 ACS 40% / KDA 50% / 현재·최고 티어 10% 기준으로 계산하고, 티어 데이터가 없으면 ACS 50% / KDA 50% 기준으로 계산합니다. 최근 20경기 조회가 실패하면 50경기, 100경기 범위로 넓혀 조회 가능한 가장 가까운 최근 경기 데이터를 사용합니다. 자동 등록 시 MMR과 최근 경기 조회는 동시에 실행합니다.

`src/services/teamBalancer.js`는 참가자 전원의 파워 스코어 합을 2팀 또는 3팀으로 나눌 때 팀 간 점수 차이가 최소가 되는 조합을 완전탐색으로 찾습니다 (최대 15명 기준).

API 응답 필드와 계산값 전체 정리는 [docs/API_DATA.md](docs/API_DATA.md)를 참고하세요.
Discord 서버 권한, 명령어별 사용법, 다른 서버에 적용하는 방법은 [docs/DISCORD_USAGE.md](docs/DISCORD_USAGE.md)를 참고하세요.
