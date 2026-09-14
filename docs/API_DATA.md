# API 데이터 정리

이 문서는 Valorant Discord Bot이 Henrik API와 VALORANT Esports 공식 데이터에서 받을 수 있는 원본 데이터와 현재 봇에서 사용하는 값을 정리한 문서입니다.

## 1. API 엔드포인트

| 용도 | 엔드포인트 | 주요 응답 |
| --- | --- | --- |
| 현재 MMR | `/valorant/v2/mmr/{region}/{name}/{tag}` | 현재 티어, Elo, 등급 내 순위, 최근 MMR 변화 |
| MMR 기록 | `/valorant/v1/mmr-history/{region}/{name}/{tag}` | 과거 티어, Elo, 경기 결과 |
| 최근 매치 | `/valorant/v3/matches/{region}/{name}/{tag}?size=20` | 최근 매치, 플레이어, 라운드, 킬, 맵, 경제 정보 |

`{region}`은 `kr`, `na`, `eu`, `ap` 중 하나이며, `{name}`과 `{tag}`는 Riot ID의 `#` 앞·뒤 값입니다.

## 2. 티어·MMR 데이터

| 응답 필드 | 의미 | 현재 봇 표시 |
| --- | --- | --- |
| `data.name` | Riot 이름 | 전적 제목 |
| `data.tag` | Riot 태그 | 전적 제목 |
| `data.puuid` | Riot 계정 고유 식별자 | 내부 조회용 |
| `data.current_data.currenttierpatched` | 현재 티어 이름 | 현재 티어 |
| `data.current_data.currenttier` | 현재 티어 숫자 | 파워 스코어 내부 계산 |
| `data.current_data.elo` | 현재 Elo | 미표시 |
| `data.current_data.ranking_in_tier` | 현재 등급 내 순위 점수 | 미표시 |
| `data.current_data.mmr_change_to_last_game` | 마지막 경기 MMR 변화 | 미표시 |
| `data.current_data.games_needed_for_rating` | 등급 평가까지 필요한 경기 수 | 미표시 |
| `data.highest_rank.patched_tier` | 최고 티어 이름 | 최고 티어 |
| `data.highest_rank.season` | 최고 티어를 기록한 시즌 | 미표시 |
| `data.current_data.images` | 티어 아이콘 URL | 미표시 |

## 3. 매치 기본 정보

| 응답 필드 | 의미 | 활용 예시 |
| --- | --- | --- |
| `metadata.map` | 맵 이름 | 맵별 승률 |
| `metadata.game_length` | 경기 시간 | 평균 경기 시간 |
| `metadata.game_start_patched` | 경기 시작 시각 | 최근 경기 목록 |
| `metadata.rounds_played` | 플레이한 라운드 수 | 라운드 통계 |
| `metadata.mode` | 게임 모드 | `Competitive`/`Unrated` 필터 |
| `metadata.queue` | 큐 종류 | `Standard`/`Swiftplay` 등 플레이리스트 구분 |
| `metadata.season_id` | 시즌 ID | 시즌별 통계 |
| `metadata.matchid` | 매치 ID | 경기 상세 식별자 |
| `metadata.region` | 매치 지역 | 지역 확인 |
| `metadata.cluster` | 서버 클러스터 | 서버별 통계 |

## 4. 플레이어 전투·경제 데이터

| 응답 필드 | 의미 | 현재 봇 표시 |
| --- | --- | --- |
| `stats.score` | 경기 점수 | ACS |
| `stats.kills` | 킬 수 | KDA, KD |
| `stats.deaths` | 데스 수 | KDA, KD |
| `stats.assists` | 어시스트 수 | KDA |
| `stats.headshots` | 헤드샷 수 | 헤드샷 비율 |
| `stats.bodyshots` | 몸샷 수 | 몸샷 비율 |
| `stats.legshots` | 다리샷 수 | 다리샷 비율 |
| `damage_made` | 가한 피해량 | ADR |
| `damage_received` | 받은 피해량 | 피해량 차이/라운드 |
| `character` | 사용 캐릭터 | 캐릭터 TOP5 |
| `currenttier_patched` | 해당 경기 당시 티어 | 미표시 |
| `level` | 계정 레벨 | 미표시 |
| `session_playtime` | 세션 플레이 시간 | 미표시 |
| `party_id` | 파티 식별자 | 미표시 |
| `behavior` | 행동 관련 정보 | 미표시 |
| `economy.spent` | 경기 중 사용한 크레딧 | 미표시 |
| `economy.loadout_value` | 장비 가치 | 미표시 |

## 5. 스킬·라운드 데이터

| 응답 필드 | 의미 | 활용 예시 |
| --- | --- | --- |
| `ability_casts.x_cast` | X 스킬 사용 횟수 | 궁극기 사용 통계 |
| `ability_casts.e_cast` | E 스킬 사용 횟수 | 스킬 사용 통계 |
| `ability_casts.q_cast` | Q 스킬 사용 횟수 | 스킬 사용 통계 |
| `ability_casts.c_cast` | C 스킬 사용 횟수 | 스킬 사용 통계 |
| `rounds[].winning_team` | 라운드 승리 팀 | 공격·수비 승률 |
| `rounds[].end_type` | 라운드 종료 방식 | 처치·시간·스파이크 결과 |
| `rounds[].bomb_planted` | 스파이크 설치 여부 | 설치 횟수 |
| `rounds[].bomb_defused` | 스파이크 해체 여부 | 해체 횟수 |
| `rounds[].plant_events` | 설치 상세 이벤트 | 설치 위치·시각 |
| `rounds[].defuse_events` | 해체 상세 이벤트 | 해체 위치·시각 |

## 6. 킬·무기 데이터

| 응답 필드 | 의미 | 현재 봇 표시 또는 활용 |
| --- | --- | --- |
| `kills[].round` | 킬이 발생한 라운드 | 멀티킬·라운드별 통계 |
| `kills[].kill_time_in_round` | 라운드 내 킬 시각 | 평균 킬 시점 |
| `kills[].kill_time_in_match` | 경기 전체 기준 킬 시각 | 선취 킬·킬 간격 |
| `kills[].killer_puuid` | 킬을 낸 플레이어 | 본인 킬 필터 |
| `kills[].victim_puuid` | 사망한 플레이어 | 피해 대상 분석 |
| `kills[].killer_team` | 킬러 팀 | 공격·수비별 분석 |
| `kills[].victim_team` | 피해자 팀 | 팀별 분석 |
| `kills[].damage_weapon_name` | 킬에 사용한 무기 | 총기별 킬 TOP5 |
| `kills[].damage_weapon_id` | 무기 고유 ID | 무기 식별 |
| `kills[].secondary_fire_mode` | 보조 사격 사용 여부 | 무기 사용 방식 |
| `kills[].assistants` | 어시스트 플레이어 목록 | 어시스트 상세 |
| `kills[].victim_death_location` | 피해자 사망 위치 | 위치별 분석 |

## 7. 현재 전적 화면 계산값

| 표시 항목 | 계산 방식 |
| --- | --- |
| KDA | `(킬 + 어시스트) / 데스` |
| KD | `킬 / 데스` |
| 승률 | 승리한 매치 수 / 조회한 매치 수 |
| ACS | 전체 경기 점수 / 전체 라운드 수 |
| ADR | `damage_made` 합계 / 플레이 라운드 수 |
| 피해량 차이/라운드 | `(가한 피해량 - 받은 피해량) / 전체 라운드 수` |
| 헤드샷·몸샷·다리샷 | 각 명중 부위 수 / 전체 명중 수 |
| 캐릭터 TOP5 | 사용 경기 수가 많은 캐릭터 순서 |
| 총기별 킬 TOP5 | 킬 수가 많은 무기 순서와 전체 킬 비중 |
| 맵별 승률 | 맵별 승리 수 / 맵별 경기 수 |
| 파워 스코어 | 티어 데이터가 있으면 ACS 40% / KDA 50% / 현재·최고 티어 10%. 티어 데이터가 없으면 ACS 50% / KDA 50% |
| 경기별 기록 | 각 경기의 맵, 승패, 캐릭터, K/D/A, ACS, ADR |

파워 스코어는 100점 만점 환산값이 아니라 팀 밸런싱을 위한 상대 비교용 점수입니다. 최근 20경기 조회가 실패하면 50경기, 100경기 범위로 넓혀 조회 가능한 가장 가까운 최근 경기 데이터를 사용합니다.

## 8. 아직 화면에 표시하지 않는 데이터

현재 API 응답에는 있지만 화면에 사용하지 않는 값입니다.

- Elo 및 등급 내 순위
- 마지막 경기 MMR 변화
- 티어 아이콘
- 경기 시간과 시작 시각
- 계정 레벨
- 파티 ID
- 스킬 사용 횟수
- 경기 중 사용 크레딧과 장비 가치
- 공격·수비별 라운드 승률
- 스파이크 설치·해체 횟수
- 선취 킬과 멀티킬
- 평균 킬 시점과 킬 간격

## 9. 제공되지 않거나 동일 재현이 어려운 지표

| 지표 | 이유 |
| --- | --- |
| Tracker Score | Tracker Network 자체 산식이므로 API 데이터만으로 동일 재현 불가 |
| KAST | 라운드별 생존·처치 관여·트레이드 산식이 필요하며 Tracker와 동일한 값 보장 불가 |
| 무기별 헤드샷·몸샷 비율 | 현재 응답은 플레이어 전체 명중 부위 수만 제공 |
| 개인 일일 상점 | Riot 공식 API에 상점 조회 엔드포인트가 없음 |

## 10. VALORANT Esports 공식 데이터

`/대회`는 `valorantesports.com`의 한국어 공식 데이터만 사용합니다.

| 용도 | 공식 데이터 | 현재 봇 표시 |
| --- | --- | --- |
| 경기 일정·결과 | `homeEvents` | 한국 시간, 상태, 대진, 승리 팀, 최종 세트 스코어, 경기 방식 |
| 대회 목록 | `GetSeasonForNavigation` | 전체 공식 대회 자동완성, 무옵션 최신 대회 선택 |
| 그룹 순위 | 공식 대회 페이지의 서버 렌더링 데이터 | 조별 순위와 승·패 |
| 세트 정보 | `match.games[]` | 세트 번호, 상태, 공식 다시보기 링크 |

경기 요청에는 공식 리그 ID를 전달해 전체 종목 300건 제한 때문에 최신 경기가 누락되지 않도록 합니다. 경기 결과는 최신 시각순이며, 브래킷 시각이 누락된 경우 Riot의 공식 경기 번호 순서를 사용합니다. `/대회 순위` 옵션을 생략하면 오늘 이전에 시작한 가장 최근 대회에서 공식 그룹 순위가 있는 최신 단계를 선택합니다.

공식 공개 데이터에는 세트별 맵 이름, 세트 승리 팀과 라운드 스코어가 없습니다. 봇은 이 값을 계산하거나 추정하지 않으며, 제공되는 세트 상태와 다시보기 링크만 표시합니다.

## 11. 관련 소스 파일

| 파일 | 역할 |
| --- | --- |
| `src/services/henrik.js` | Henrik API 호출과 매치 데이터 계산 |
| `src/commands/stats.js` | `/전적` 화면 표시 |
| `src/services/scoring.js` | 파워 스코어 계산 |
| `src/services/teamPower.js` | 팀짜기용 파워 스코어 조회·캐시 |
| `src/services/valorantEsports.js` | 공식 대회 일정, 대회 목록, 순위와 경기 결과 조회 |
| `src/commands/esports.js` | `/대회` 화면, 최신순 정렬, 페이지 이동과 오류 안내 |

팀짜기는 `/전적`처럼 전체 상세 통계를 계산하지 않고, 파워 스코어에 필요한 KDA, ACS, 현재/최고 티어만 경량 조회합니다.
