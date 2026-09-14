import axios from 'axios';

const NEWS_PAGES = [
  { url: 'https://playvalorant.com/en-us/news/', locale: 'en-us' },
  { url: 'https://playvalorant.com/ko-kr/news/', locale: 'ko-kr' },
];
const INCLUDED_CATEGORIES = new Set(['announcements', 'game-updates']);

function extractNewsItems(html, locale) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error(`${locale} 공식 뉴스 데이터를 찾지 못했습니다.`);

  const nextData = JSON.parse(match[1]);
  const page = nextData?.props?.pageProps?.page;
  const grid = page?.blades?.find((blade) => blade.type === 'articleCardGrid');
  if (!grid?.items) throw new Error(`${locale} 공식 뉴스 목록을 찾지 못했습니다.`);

  return grid.items
    .filter((item) => INCLUDED_CATEGORIES.has(item.category?.machineName))
    .filter((item) => locale === 'ko-kr' || item.category?.machineName === 'game-updates')
    .map((item) => ({
      id: item.analytics?.contentId?.split('.')[0] ?? item.action?.payload?.url,
      title: item.title,
      description: item.description?.body?.replace(/<[^>]+>/g, '').trim() ?? '',
      category: item.category?.machineName,
      categoryName: item.category?.title ?? item.category?.machineName,
      publishedAt: item.publishedAt,
      url: new URL(item.action?.payload?.url, page.baseUrl).href,
      image: item.imageMedia?.url ?? item.media?.url ?? null,
      locale,
    }))
    .filter((item) => item.id && item.title && item.publishedAt && item.url);
}

export async function fetchOfficialValorantNews() {
  const results = await Promise.allSettled(NEWS_PAGES.map(async ({ url, locale }) => {
    const { data } = await axios.get(url, { timeout: 15000 });
    return extractNewsItems(data, locale);
  }));
  const successful = results.filter((result) => result.status === 'fulfilled');
  if (!successful.length) throw new Error('발로란트 공식 뉴스 페이지를 불러오지 못했습니다.');

  const articlesById = new Map();
  for (const result of successful) {
    for (const article of result.value) articlesById.set(article.id, article);
  }
  return [...articlesById.values()]
    .filter((article) => new Date(article.publishedAt) <= new Date())
    .sort((left, right) => new Date(left.publishedAt) - new Date(right.publishedAt));
}