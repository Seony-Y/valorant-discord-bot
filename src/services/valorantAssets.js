import axios from 'axios';

const ASSET_CACHE_TTL_MS = 60 * 60 * 1000;
const ASSET_REFRESH_RETRY_MS = 5 * 60 * 1000;

let assetsCache;
let assetsCachedAt = 0;
let assetsCachePromise;

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
  const [skins, tiers, buddies, playercards, sprays, flex, bundles] = await Promise.all([
    'weapons/skins',
    'contenttiers',
    'buddies',
    'playercards',
    'sprays',
    'flex',
    'bundles',
  ].map(fetchAssetList));
  return {
    skins,
    itemsById: indexItems([skins, buddies, playercards, sprays, flex]),
    tiersById: new Map(tiers.map((tier) => [tier.uuid, tier])),
    bundlesById: new Map(bundles.map((bundle) => [bundle.uuid, bundle])),
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
