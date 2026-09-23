/**
 * ⚠️ RISK WARNING ⚠️
 * This module uses Riot Client QR login because Riot's public API does not
 * expose the in-game store to third parties. Treat the encrypted session cookie
 * as a password-equivalent secret and require explicit user opt-in.
 */
import axios from 'axios';
import crypto from 'node:crypto';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const ALGO = 'aes-256-gcm';
const QR_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CLIENT_VERSION_CACHE_TTL_MS = 15 * 60 * 1000;
const pendingQrLogins = new Map();
const clientVersionCache = new Map();
const mediaImageCache = new Map();
const ITEM_TYPE_MEDIA_PATHS = new Map([
  ['e7c63390-eda7-46e0-bb7a-a6abdacd2433', 'weaponskinlevels'],
  ['dd3bf334-87f3-40bd-b043-682a57a8dc3a', 'buddylevels'],
  ['3f296c07-64c3-494c-923b-fe692a4fa1bd', 'playercards'],
  ['d5f120f8-ff8c-4aac-92ea-f2b5acbe9475', 'sprays'],
]);

async function getMediaImage(path, itemId) {
  if (!path || !itemId) return null;
  const url = `https://media.valorant-api.com/${path}/${itemId}/displayicon.png`;
  if (!mediaImageCache.has(url)) {
    mediaImageCache.set(url, axios.head(url)
      .then(({ headers }) => headers['content-type']?.startsWith('image/') ? url : null)
      .catch(() => null));
  }
  return mediaImageCache.get(url);
}

async function getRiotClientVersion(shard) {
  const region = String(shard ?? 'kr').toLowerCase();
  const cached = clientVersionCache.get(region);
  if (cached && Date.now() - cached.updatedAt < CLIENT_VERSION_CACHE_TTL_MS) return cached.version;

  let version;
  try {
    const { data } = await axios.get(`https://api.henrikdev.xyz/valorant/v1/version/${region}`, {
      headers: { Authorization: process.env.HENRIK_API_KEY },
    });
    version = data.data?.version_for_api;
  } catch (error) {
    console.warn(`Riot 클라이언트 지역 버전 조회 실패 (${region}): ${error.message}`);
  }

  if (!version) {
    const { data } = await axios.get('https://valorant-api.com/v1/version');
    version = data.data.riotClientVersion;
  }
  clientVersionCache.set(region, { version, updatedAt: Date.now() });
  return version;
}

async function requestWithCurrentClientVersion(shard, request) {
  const region = String(shard ?? 'kr').toLowerCase();
  const clientVersion = await getRiotClientVersion(region);
  try {
    return await request(clientVersion);
  } catch (error) {
    if (![400, 403].includes(error.response?.status)) throw error;

    clientVersionCache.delete(region);
    const refreshedVersion = await getRiotClientVersion(region);
    if (refreshedVersion === clientVersion) throw error;
    console.info(`Riot 클라이언트 버전 자동 갱신: ${clientVersion} -> ${refreshedVersion}`);
    return request(refreshedVersion);
  }
}

export function encryptCredential(plainText) {
  const key = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return {
    encrypted: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

export function decryptCredential({ encrypted, iv, authTag }) {
  const key = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function newSession() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));
  return { client, jar };
}

function createTraceparent() {
  return `00-${crypto.randomUUID().replaceAll('-', '')}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}-00`;
}

function qrHeaders(sdkSid, countryCode) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'RiotGamesApi/24.10.1.4471 rso-authenticator (Windows;10;;Professional, x64) riot_client/0',
    baggage: `sdksid=${sdkSid}`,
    traceparent: createTraceparent(),
    'country-code': countryCode,
  };
}

function parseAuthorizationUri(uri) {
  const authorizationUrl = new URL(uri);
  const parameters = new URLSearchParams(authorizationUrl.search);
  for (const [key, value] of new URLSearchParams(authorizationUrl.hash.slice(1))) {
    parameters.set(key, value);
  }
  const accessToken = parameters.get('access_token');
  const idToken = parameters.get('id_token');
  if (!accessToken || !idToken) {
    const error = parameters.get('error') ?? parameters.get('error_code');
    throw new Error(error ? `Riot 인증이 거부되었습니다 (${error}).` : 'Riot 인증 응답에 필요한 토큰이 없습니다.');
  }
  return { accessToken, idToken };
}

function createSessionExpiredError() {
  const error = new Error('Riot 로그인 세션이 만료되었습니다. `/상점연동`을 다시 실행해주세요.');
  error.code = 'RIOT_SESSION_EXPIRED';
  return error;
}

function createServiceUnavailableError() {
  const error = new Error('Riot 서버가 점검 중이거나 일시적으로 상점 요청을 차단하고 있습니다. 잠시 후 다시 시도해주세요.');
  error.code = 'RIOT_SERVICE_UNAVAILABLE';
  return error;
}

function throwMappedRiotAuthError(error) {
  if (error.response?.status === 401) throw createSessionExpiredError();
  if (error.response?.status === 403) throw createServiceUnavailableError();
  throw error;
}

async function getSsid(jar) {
  const cookies = await jar.getCookies('https://auth.riotgames.com');
  return cookies.find((cookie) => cookie.key === 'ssid')?.value ?? null;
}

function extractRotatedSsid(setCookieHeaders, previousSsid) {
  for (const header of setCookieHeaders ?? []) {
    const match = header.match(/^ssid=([^;]+)/);
    if (match && match[1] && match[1] !== previousSsid) return match[1];
  }
  return null;
}

export async function startRiotQrLogin(countryCode = process.env.RIOT_QR_LOCALE ?? 'ko-KR') {
  const { client, jar } = newSession();
  const sdkSid = crypto.randomUUID();
  const headers = qrHeaders(sdkSid, countryCode);
  const region = countryCode.toUpperCase().startsWith('KO') ? 'KR' : 'NA';

  await client.get('https://clientconfig.rpg.riotgames.com/api/v1/config/public', {
    headers: {
      ...headers,
      'User-Agent': 'RiotGamesApi/24.10.1.4471 client-config (Windows;10;;Professional, x64) riot_client/0',
    },
    params: {
      os: 'windows',
      region,
      app: 'Riot Client',
      version: '97.0.1.2366',
      patchline: 'KeystoneFoundationLiveWin',
    },
  });

  await client.get('https://auth.riotgames.com/.well-known/openid-configuration', { headers });
  const { data } = await client.post(
    'https://authenticate.riotgames.com/api/v1/login',
    {
      client_id: 'riot-client',
      language: countryCode.replace('-', '_'),
      platform: 'windows',
      remember: true,
      type: 'auth',
      qrcode: {},
    },
    { headers }
  );

  if (!data.cluster || !data.suuid || !data.timestamp) {
    throw new Error('Riot에서 QR 로그인 정보를 받지 못했습니다. 잠시 후 다시 시도해주세요.');
  }

  const id = crypto.randomUUID();
  pendingQrLogins.set(id, { client, jar, sdkSid, countryCode, expiresAt: Date.now() + QR_LOGIN_TIMEOUT_MS });
  setTimeout(() => pendingQrLogins.delete(id), QR_LOGIN_TIMEOUT_MS).unref();

  return {
    id,
    loginUrl: `https://qrlogin.riotgames.com/riotmobile?cluster=${encodeURIComponent(data.cluster)}&suuid=${encodeURIComponent(data.suuid)}&timestamp=${encodeURIComponent(data.timestamp)}&utm_source=riotclient&utm_medium=client&utm_campaign=qrlogin-riotmobile`,
  };
}

async function redeemQrLoginToken(loginToken) {
  const { client, jar } = newSession();
  const sdkSid = crypto.randomUUID();
  const headers = qrHeaders(sdkSid, 'ko-KR');
  const loginTokenResponse = await client.post(
    'https://auth.riotgames.com/api/v1/login-token',
    { authentication_type: null, code_verifier: '', login_token: loginToken, persist_login: true },
    { headers, validateStatus: (status) => status === 204 }
  );

  if (loginTokenResponse.status !== 204) throw new Error('Riot QR 로그인 토큰 교환에 실패했습니다.');

  const { data } = await client.post(
    'https://auth.riotgames.com/api/v1/authorization',
    {
      acr_values: '',
      claims: '',
      client_id: 'riot-client',
      code_challenge: '',
      code_challenge_method: '',
      nonce: crypto.randomUUID(),
      redirect_uri: 'http://localhost/redirect',
      response_type: 'token id_token',
      scope: 'openid link ban lol_region account',
    },
    { headers }
  );
  const uri = data.response?.parameters?.uri;
  if (!uri) throw new Error('Riot QR 로그인 토큰 응답이 올바르지 않습니다.');

  const { accessToken, idToken } = parseAuthorizationUri(uri);
  const session = await completeAuthorization(client, headers, {
    type: 'response',
    response: { parameters: { uri } },
  });
  const ssid = await getSsid(jar);
  if (!ssid) throw new Error('Riot 재인증 쿠키를 받지 못했습니다. QR 로그인을 다시 시도해주세요.');
  return { ...session, accessToken, idToken, ssid };
}

export async function checkRiotQrLogin(id) {
  const pending = pendingQrLogins.get(id);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingQrLogins.delete(id);
    throw new Error('QR 로그인 시간이 만료되었습니다. `/상점연동`을 다시 실행해주세요.');
  }

  const { data } = await pending.client.get('https://authenticate.riotgames.com/api/v1/login', {
    headers: qrHeaders(pending.sdkSid, pending.countryCode),
  });
  if (data.type !== 'success') return null;

  pendingQrLogins.delete(id);
  const loginToken = data.success?.login_token;
  if (!loginToken) throw new Error('Riot QR 승인은 완료됐지만 로그인 토큰을 받지 못했습니다.');
  return redeemQrLoginToken(loginToken);
}

export async function restoreRiotStoreSession({ ssid, puuid, shard }) {
  const { headers } = await axios.get('https://auth.riotgames.com/authorize', {
    params: {
      redirect_uri: 'https://playvalorant.com/opt_in',
      client_id: 'play-valorant-web-prod',
      response_type: 'token id_token',
      nonce: '1',
      scope: 'account openid',
    },
    headers: { Cookie: `ssid=${ssid}`, 'User-Agent': 'RiotClient/1.0' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  }).catch(throwMappedRiotAuthError);
  const location = headers.location;
  if (!location) throw createSessionExpiredError();

  let accessToken;
  try {
    ({ accessToken } = parseAuthorizationUri(location));
  } catch {
    throw createSessionExpiredError();
  }

  const entitlementsRes = await axios.post(
    'https://entitlements.auth.riotgames.com/api/token/v1',
    {},
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      validateStatus: (status) => status >= 200 && status < 300,
    }
  ).catch(throwMappedRiotAuthError);
  // Riot rotates the ssid cookie on every reauth; persist it or the session expires early.
  const rotatedSsid = extractRotatedSsid(headers['set-cookie'], ssid);
  return { accessToken, entitlementsToken: entitlementsRes.data.entitlements_token, puuid, shard, rotatedSsid };
}

async function completeAuthorization(client, headers, authData) {
  if (authData.type !== 'response') {
    const reason = authData.error ?? authData.error_code ?? authData.type ?? 'unknown';
    if (reason === 'auth_failure') {
      throw new Error(
        'Riot이 자동 로그인을 거부했습니다. 로그인 아이디/비밀번호가 맞아도 비공식 로그인 차단, CAPTCHA, 계정 보안 정책 때문에 발생할 수 있으며 2FA 코드 단계까지 진행되지 않았습니다.'
      );
    }
    throw new Error(`Riot 인증이 완료되지 않았습니다 (${reason}). Riot에서 2FA 요청을 보내지 않은 상태입니다.`);
  }

  const callbackUri = authData.response.parameters.uri;
  const { accessToken, idToken } = parseAuthorizationUri(callbackUri);

  const entitlementsRes = await client.post(
    'https://entitlements.auth.riotgames.com/api/token/v1',
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const entitlementsToken = entitlementsRes.data.entitlements_token;

  const userInfoRes = await client.get('https://auth.riotgames.com/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const puuid = userInfoRes.data.sub;

  const geoRes = await client.put(
    'https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant',
    { id_token: idToken },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const shard = geoRes.data.affinities.live;

  return { accessToken, entitlementsToken, puuid, shard };
}

export async function getRiotDisplayName({ accessToken, entitlementsToken, puuid, shard }) {
  const clientPlatform = Buffer.from(
    JSON.stringify({
      platformType: 'PC',
      platformOS: 'Windows',
      platformOSVersion: '10.0.19042.1.256.64bit',
      platformChipset: 'Unknown',
    })
  ).toString('base64');

  const { data } = await requestWithCurrentClientVersion(shard, (clientVersion) => axios.put(
    `https://pd.${shard}.a.pvp.net/name-service/v2/players`,
    [puuid],
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientVersion': clientVersion,
        'X-Riot-ClientPlatform': clientPlatform,
      },
    }
  )).catch(throwMappedRiotAuthError);
  const player = data?.[0];
  return player?.GameName && player?.TagLine
    ? { riotName: player.GameName, riotTag: player.TagLine }
    : null;
}

/** Fetch the raw storefront (bundle/offer UUIDs, not human names). */
export async function getStorefront({ accessToken, entitlementsToken, puuid, shard }) {
  const clientPlatform = Buffer.from(
    JSON.stringify({
      platformType: 'PC',
      platformOS: 'Windows',
      platformOSVersion: '10.0.19042.1.256.64bit',
      platformChipset: 'Unknown',
    })
  ).toString('base64');

  const { data } = await requestWithCurrentClientVersion(shard, (clientVersion) => axios.post(
    `https://pd.${shard}.a.pvp.net/store/v3/storefront/${puuid}`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientPlatform': clientPlatform,
        'X-Riot-ClientVersion': clientVersion,
      },
    }
  )).catch(throwMappedRiotAuthError);
  return data;
}

export async function getRiotContent({ accessToken, entitlementsToken, shard }) {
  const clientPlatform = Buffer.from(
    JSON.stringify({
      platformType: 'PC',
      platformOS: 'Windows',
      platformOSVersion: '10.0.19042.1.256.64bit',
      platformChipset: 'Unknown',
    })
  ).toString('base64');

  const { data } = await requestWithCurrentClientVersion(shard, (clientVersion) => axios.get(
    `https://shared.${shard}.a.pvp.net/content-service/v3/content`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientPlatform': clientPlatform,
        'X-Riot-ClientVersion': clientVersion,
      },
    }
  )).catch(throwMappedRiotAuthError);
  return data;
}

function resolveSkinImage(skin, itemId = null) {
  const level = skin?.levels?.find((entry) => entry.uuid === itemId);
  const chroma = skin?.chromas?.find((entry) => entry.uuid === itemId);
  return level?.displayIcon
    ?? chroma?.displayIcon
    ?? skin?.displayIcon
    ?? skin?.levels?.find((entry) => entry.displayIcon)?.displayIcon
    ?? skin?.chromas?.find((entry) => entry.displayIcon)?.displayIcon
    ?? skin?.chromas?.find((entry) => entry.fullRender)?.fullRender
    ?? null;
}

/** Map skin panel offer UUIDs to display metadata via valorant-api.com. */
export async function resolveSkinOffers(offerIds) {
  const [skinsResponse, tiersResponse] = await Promise.all([
    axios.get('https://valorant-api.com/v1/weapons/skins?language=ko-KR'),
    axios.get('https://valorant-api.com/v1/contenttiers?language=ko-KR'),
  ]);
  const skins = skinsResponse.data.data;
  const tiers = tiersResponse.data.data;
  return offerIds.map((id) => {
    const skin = skins.find((s) => s.levels?.some((l) => l.uuid === id) || s.chromas?.some((c) => c.uuid === id));
    const tier = tiers.find((entry) => entry.uuid === skin?.contentTierUuid);
    return {
      name: skin?.displayName ?? id,
      image: resolveSkinImage(skin, id),
      tierImage: tier?.displayIcon ?? null,
      tierColor: tier?.highlightColor ?? null,
    };
  });
}

export async function searchWeaponSkins(query = '') {
  const { data } = await axios.get('https://valorant-api.com/v1/weapons/skins?language=ko-KR');
  const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR');
  return data.data
    .filter((skin) => skin.displayName?.toLocaleLowerCase('ko-KR').includes(normalizedQuery))
    .slice(0, 25)
    .map((skin) => ({ name: skin.displayName, image: resolveSkinImage(skin) }));
}

function findRiotContentItem(content, itemId) {
  if (!content || !itemId) return null;

  const normalizedItemId = itemId.toLowerCase();
  const pending = [content];
  const visited = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);

    const id = value.ID ?? value.id ?? value.UUID ?? value.uuid;
    if (typeof id === 'string' && id.toLowerCase() === normalizedItemId) return value;
    pending.push(...Object.values(value).filter((entry) => entry && typeof entry === 'object'));
  }
  return null;
}

function findContentItem(contents, itemId) {
  return (Array.isArray(contents) ? contents : [contents])
    .map((content) => findRiotContentItem(content, itemId))
    .find(Boolean);
}

function getRiotContentName(item) {
  const localizedNames = item?.LocalizedNames ?? item?.localizedNames;
  const name = localizedNames?.['ko-KR']
    ?? localizedNames?.ko_KR
    ?? item?.Name
    ?? item?.name
    ?? null;
  return /^(warden|워든)(?:\s*(?:bundle|번들))?$/i.test(name?.trim() ?? '')
    ? '2026 챔피언스'
    : name;
}

function getRiotContentImage(item) {
  const image = item?.DisplayIcon
    ?? item?.displayIcon
    ?? item?.Icon
    ?? item?.icon
    ?? item?.Image
    ?? item?.image;
  return typeof image === 'string' && /^https?:\/\//i.test(image) ? image : null;
}

export async function resolveStoreItems(itemIds, riotContent = null, itemTypes = []) {
  const endpoints = [
    'weapons/skins',
    'contenttiers',
    'buddies',
    'playercards',
    'sprays',
    'flex',
  ];
  const responses = await Promise.all(
    endpoints.map((endpoint) => axios.get(`https://valorant-api.com/v1/${endpoint}?language=ko-KR`))
  );
  const items = responses.flatMap((response) => response.data.data);
  const tiers = responses[1].data.data;

  return Promise.all(itemIds.map(async (id, index) => {
    const item = items.find(
      (entry) => entry.uuid === id || entry.levels?.some((level) => level.uuid === id) || entry.chromas?.some((chroma) => chroma.uuid === id)
    );
    const riotItem = findContentItem(riotContent, id);
    const tier = tiers.find((entry) => entry.uuid === item?.contentTierUuid);
    const knownImage = resolveSkinImage(item, id)
      ?? item?.fullIcon
      ?? item?.largeArt
      ?? item?.wideArt
      ?? getRiotContentImage(riotItem);
    const mediaImage = knownImage ? null : await getMediaImage(
        ITEM_TYPE_MEDIA_PATHS.get(itemTypes[index]?.toLowerCase()),
        id,
      );
    if (!item && !riotItem) {
      console.warn('[store-metadata] unresolved item', {
        itemId: id,
        itemTypeId: itemTypes[index] ?? null,
      });
    }
    return {
      name: item?.displayName ?? getRiotContentName(riotItem) ?? '이름 정보 확인 중',
      image: knownImage ?? mediaImage,
      tierImage: tier?.displayIcon ?? null,
      tierName: tier?.displayName ?? '콘텐츠 티어',
    };
  }));
}

export async function resolveBundle(bundleId, alternateId = null, storefrontBundle = null, riotContent = null) {
  if (!bundleId && !alternateId) return null;
  const { data } = await axios.get('https://valorant-api.com/v1/bundles?language=ko-KR');
  const bundle = data.data.find((entry) => entry.uuid === bundleId || entry.uuid === alternateId);
  if (!bundle) {
    const riotBundle = findContentItem(riotContent, alternateId)
      ?? findContentItem(riotContent, bundleId);
    const name = storefrontBundle?.DisplayName
      ?? storefrontBundle?.displayName
      ?? storefrontBundle?.Name
      ?? storefrontBundle?.name
      ?? getRiotContentName(riotBundle)
      ?? '출시 예정 번들';
    const image = storefrontBundle?.DisplayIcon
      ?? storefrontBundle?.displayIcon
      ?? storefrontBundle?.Image
      ?? storefrontBundle?.image
      ?? storefrontBundle?.VerticalPromoImage
      ?? storefrontBundle?.verticalPromoImage
      ?? getRiotContentImage(riotBundle)
      ?? await getMediaImage('bundles', alternateId);
    if (!riotBundle && name === '출시 예정 번들') {
      console.warn('[store-metadata] unresolved bundle', { bundleId, dataAssetId: alternateId });
    }
    return {
      name,
      image: typeof image === 'string' && /^https?:\/\//i.test(image) ? image : null,
    };
  }
  return {
    name: bundle.displayName,
    image: bundle.displayIcon ?? bundle.verticalPromoImage ?? null,
  };
}
