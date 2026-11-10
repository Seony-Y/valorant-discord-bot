import axios from 'axios';
import { supabase } from './supabase.js';

const ASSET_CACHE_TTL_MS = 60 * 60 * 1000;
const ASSET_REFRESH_RETRY_MS = 5 * 60 * 1000;
// valorant-api.com lags behind new store content; refetch when the store shows ids we don't know, at most this often.
const MISSING_ASSET_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const BUNDLE_OVERRIDE_CACHE_TTL_MS = 5 * 60 * 1000;
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

let assetsCache;
let assetsCachedAt = 0;
let assetsCachePromise;
let missingAssetRefreshedAt = 0;
let bundleOverridesCache;
let bundleOverridesCachedAt = 0;
const unresolvedBundles = new Map();
const unresolvedBundleListeners = new Set();

async function fetchAssetList(endpoint) {
  const { data } = await axios.get(`https://valorant-api.com/v1/${endpoint}?language=ko-KR`, { timeout: 15_000 });
  return data.data ?? [];
}

// Store offers reference an item, one of its levels or one of its chromas, so every one of those uuids maps back to the item.
function indexItems(lists) {
  const itemsById = new Map();
  for (const list of lists) {
    for (const item of list) {
      for (const id of [item.uuid, ...(item.levels ?? []).map(({ uuid }) => uuid), ...(item.chromas ?? []).map(({ uuid }) => uuid)]) {
        if (id && !itemsById.has(id)) itemsById.set(id, item);
      }
    }
  }
  return itemsById;
}

async function loadValorantAssets() {
  const [skins, tiers, buddies, playercards, sprays, flex, bundles, themes] = await Promise.all([
    'weapons/skins',
    'contenttiers',
    'buddies',
    'playercards',
    'sprays',
    'flex',
    'bundles',
    'themes',
  ].map(fetchAssetList));
  return {
    skins,
    itemsById: indexItems([skins, buddies, playercards, sprays, flex]),
    tiersById: new Map(tiers.map((tier) => [tier.uuid, tier])),
    bundlesById: new Map(bundles.map((bundle) => [bundle.uuid, bundle])),
    themesById: new Map(themes.map((theme) => [theme.uuid, theme])),
  };
}

/** Cached valorant-api.com metadata (ko-KR); falls back to the stale copy if a refresh fails. */
export async function getValorantAssets() {
  if (assetsCache && Date.now() - assetsCachedAt < ASSET_CACHE_TTL_MS) return assetsCache;
  if (assetsCachePromise) return assetsCachePromise;

  assetsCachePromise = loadValorantAssets()
    .then((assets) => {
      assetsCache = assets;
      assetsCachedAt = Date.now();
      return assets;
    })
    .catch((error) => {
      if (!assetsCache) throw error;
      console.warn(`valorant-api 메타데이터 갱신 실패, 기존 캐시 사용: ${error.message}`);
      // Keep serving the stale copy and retry after a short delay instead of on every request.
      assetsCachedAt = Date.now() - ASSET_CACHE_TTL_MS + ASSET_REFRESH_RETRY_MS;
      return assetsCache;
    })
    .finally(() => {
      assetsCachePromise = undefined;
    });
  return assetsCachePromise;
}

/** Refetch the metadata early (throttled) when the store references items or bundles the cache doesn't know yet. */
export async function ensureValorantAssets({ itemIds = [], bundleIds = [] } = {}) {
  const assets = await getValorantAssets();
  const missing = itemIds.some((id) => id && !assets.itemsById.has(id))
    || bundleIds.some((id) => id && !assets.bundlesById.has(id));
  if (!missing || Date.now() - missingAssetRefreshedAt < MISSING_ASSET_REFRESH_INTERVAL_MS) return assets;

  missingAssetRefreshedAt = Date.now();
  console.info('[store-metadata] unknown store ids, refreshing valorant-api metadata');
  if (!assetsCachePromise) assetsCachedAt = 0;
  return getValorantAssets();
}

export function clearValorantAssetsCache() {
  assetsCachedAt = 0;
  missingAssetRefreshedAt = 0;
  bundleOverridesCachedAt = 0;
}

/** Operator-entered bundle names/images (bundle_overrides) for bundles valorant-api.com hasn't added yet. */
export async function getBundleOverrides() {
  if (bundleOverridesCache && Date.now() - bundleOverridesCachedAt < BUNDLE_OVERRIDE_CACHE_TTL_MS) return bundleOverridesCache;
  const { data, error } = await supabase.from('bundle_overrides').select('bundle_id, name, image_url');
  if (error) {
    if (!MISSING_TABLE_CODES.has(error.code)) console.warn(`번들 수동 정보 조회 실패: ${error.message}`);
    // Back off for a cache period instead of querying again on every store lookup.
    bundleOverridesCache ??= new Map();
    bundleOverridesCachedAt = Date.now();
    return bundleOverridesCache;
  }
  bundleOverridesCache = new Map((data ?? []).map((row) => [row.bundle_id.toLowerCase(), row]));
  bundleOverridesCachedAt = Date.now();
  return bundleOverridesCache;
}

export function invalidateBundleOverrides() {
  bundleOverridesCachedAt = 0;
}

export function onUnresolvedBundle(listener) {
  unresolvedBundleListeners.add(listener);
}

export function recordUnresolvedBundle(bundleId, itemNames = []) {
  if (!bundleId) return;
  const existing = unresolvedBundles.get(bundleId);
  const entry = {
    bundleId,
    itemNames: itemNames.length ? itemNames : existing?.itemNames ?? [],
    firstSeenAt: existing?.firstSeenAt ?? new Date(),
    lastSeenAt: new Date(),
  };
  unresolvedBundles.set(bundleId, entry);
  if (existing) return;
  for (const listener of unresolvedBundleListeners) {
    Promise.resolve()
      .then(() => listener(entry))
      .catch((error) => console.warn(`신규 번들 알림 처리 실패: ${error.message}`));
  }
}

export function forgetUnresolvedBundle(bundleId) {
  unresolvedBundles.delete(bundleId);
}

export function getUnresolvedBundles() {
  return [...unresolvedBundles.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}
