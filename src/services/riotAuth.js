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
const pendingQrLogins = new Map();

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
      remember: false,
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
    { authentication_type: null, code_verifier: '', login_token: loginToken, persist_login: false },
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
  });
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
  ).catch((error) => {
    if ([401, 403].includes(error.response?.status)) throw createSessionExpiredError();
    throw error;
  });
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
  const versionRes = await axios.get('https://valorant-api.com/v1/version');
  const clientVersion = versionRes.data.data.riotClientVersion;
  const clientPlatform = Buffer.from(
    JSON.stringify({
      platformType: 'PC',
      platformOS: 'Windows',
      platformOSVersion: '10.0.19042.1.256.64bit',
      platformChipset: 'Unknown',
    })
  ).toString('base64');

  const { data } = await axios.put(
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
  );
  const player = data?.[0];
  return player?.GameName && player?.TagLine
    ? { riotName: player.GameName, riotTag: player.TagLine }
    : null;
}

/** Fetch the raw storefront (bundle/offer UUIDs, not human names). */
export async function getStorefront({ accessToken, entitlementsToken, puuid, shard }) {
  const versionRes = await axios.get('https://valorant-api.com/v1/version');
  const clientVersion = versionRes.data.data.riotClientVersion;
  const clientPlatform = Buffer.from(
    JSON.stringify({
      platformType: 'PC',
      platformOS: 'Windows',
      platformOSVersion: '10.0.19042.1.256.64bit',
      platformChipset: 'Unknown',
    })
  ).toString('base64');

  const { data } = await axios.post(
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
  );
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

export async function resolveStoreItems(itemIds) {
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

  return itemIds.map((id) => {
    const item = items.find(
      (entry) => entry.uuid === id || entry.levels?.some((level) => level.uuid === id) || entry.chromas?.some((chroma) => chroma.uuid === id)
    );
    const tier = tiers.find((entry) => entry.uuid === item?.contentTierUuid);
    return {
      name: item?.displayName ?? id,
      image: resolveSkinImage(item, id) ?? item?.fullIcon ?? item?.largeArt ?? item?.wideArt ?? null,
      tierImage: tier?.displayIcon ?? null,
      tierName: tier?.displayName ?? '콘텐츠 티어',
    };
  });
}

export async function resolveBundle(bundleId, alternateId = null) {
  if (!bundleId && !alternateId) return null;
  const { data } = await axios.get('https://valorant-api.com/v1/bundles?language=ko-KR');
  const bundle = data.data.find((entry) => entry.uuid === bundleId || entry.uuid === alternateId);
  if (!bundle) return { name: bundleId ?? alternateId, image: null };
  return {
    name: bundle.displayName,
    image: bundle.displayIcon ?? bundle.verticalPromoImage ?? null,
  };
}
