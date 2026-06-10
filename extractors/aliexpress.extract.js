// AliExpress product search extractor for Agent Browser Runtime.
//
// Modes:
// - imageSearch: extract product cards from an AliExpress image-search results page.
// - textSearch: type a query into AliExpress search, then extract product cards.
// - auto: infer mode from URL and params.
//
// Usage from the Agent Browser Runtime repo:
//   ./cli/brs.js extract aliexpress.extract.js \
//     'https://www.aliexpress.com/' \
//     --params '{"mode":"imageSearch","maxItems":30,"requireSales":true,"filter":"women blazer double breasted gold buttons"}' \
//     --file /absolute/path/to/reference-image.png \
//     --agent codex --task aliexpress-image-search --humanize standard --active true --save-html

export const schema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    mode: { type: 'string', enum: ['auto', 'imageSearch', 'textSearch'], default: 'auto' },
    query: { type: 'string', default: '' },
    filter: { type: 'string', default: '' },
    maxItems: { type: 'integer', default: 50 },
    requireSales: { type: 'boolean', default: true },
    minPrecisionScore: { type: 'integer', default: 0 },
    maxScrolls: { type: 'integer', default: 6 },
    scrollPauseMs: { type: 'integer', default: 900 },
    pageLoadWaitMs: { type: 'integer', default: 2500 },
    actionDelayMs: { type: 'integer', default: 180 },
    uploadFile: { type: 'object' },
    imageSearchButtonSelector: { type: 'string', default: '.search--picSearch--3aeyGeH, img[alt="Search by image"]' },
    uploadSelector: { type: 'string', default: 'input[type="file"]' },
    uploadWaitMs: { type: 'integer', default: 6000 },
  },
};

export async function extract({ pageHtml = '', url, finalUrl, params = {}, ui }) {
  const config = normalizeParams(params);
  const targetUrl = finalUrl || url || '';
  const mode = config.mode === 'auto' ? inferMode(targetUrl, config) : config.mode;

  if (config.pageLoadWaitMs > 0) await sleep(config.pageLoadWaitMs);

  if (mode === 'textSearch') {
    await runTextSearch(ui, config);
  } else if (mode === 'imageSearch' && config.uploadFile) {
    await runImageSearchUpload(ui, config);
  }

  const html = await collectResultsHtml({ pageHtml, ui, config });
  const parsed = parseAliExpressProducts(html, { url: targetUrl, filter: config.filter || config.query });
  const filtered = parsed
    .map((item, index) => ({
      ...item,
      source: 'aliexpress',
      mode,
      result_rank: item.result_rank || index + 1,
    }))
    .filter((item) => !config.requireSales || item.sold_count > 0)
    .filter((item) => item.precision_score >= config.minPrecisionScore)
    .slice(0, config.maxItems);

  return {
    source: 'aliexpress',
    kind: 'product_search_results',
    mode,
    url: targetUrl,
    query: config.query,
    filter: config.filter,
    total: filtered.length,
    products: filtered,
    diagnostics: {
      parsed: parsed.length,
      requireSales: config.requireSales,
      minPrecisionScore: config.minPrecisionScore,
      maxScrolls: config.maxScrolls,
      htmlLength: html.length,
    },
  };
}

async function runTextSearch(ui, config) {
  if (!config.query) throw new Error('textSearch mode requires params.query');
  await ui?.waitFor?.({ selector: '#search-words, input[name="SearchText"], input[type="search"]', timeoutMs: 15000 }).catch(() => null);
  await pause(config.actionDelayMs);
  const selector = '#search-words, input[name="SearchText"], input[type="search"]';
  await ui?.click?.({ selector, pauseAfterMs: config.actionDelayMs });
  await pause(config.actionDelayMs);
  await ui?.type?.({
    selector,
    text: config.query,
    minDelayMs: config.actionDelayMs,
    maxDelayMs: config.actionDelayMs + 120,
    pauseAfterMs: config.actionDelayMs,
  });
  await pause(config.actionDelayMs);
  await ui?.press?.({ key: 'Enter', pauseAfterMs: Math.max(config.actionDelayMs, 500) });
  await sleep(3500);
}

async function runImageSearchUpload(ui, config) {
  if (!ui?.uploadFile) throw new Error('imageSearch upload requires runtime ui.uploadFile support');
  await ui?.waitFor?.({ selector: config.imageSearchButtonSelector, timeoutMs: 15000 }).catch(() => null);
  await pause(config.actionDelayMs);
  await ui?.click?.({ selector: config.imageSearchButtonSelector, pauseAfterMs: config.actionDelayMs }).catch(() => null);
  await pause(config.actionDelayMs);
  await ui?.waitFor?.({ selector: config.uploadSelector, timeoutMs: 10000 }).catch(() => null);
  await ui.uploadFile({
    selector: config.uploadSelector,
    file: config.uploadFile,
    pauseAfterMs: config.actionDelayMs,
  });
  await sleep(config.uploadWaitMs);
}

async function collectResultsHtml({ pageHtml, ui, config }) {
  let html = pageHtml || '';
  await ui?.waitFor?.({ selector: 'a.search-card-item, [data-spm-anchor-id], body', timeoutMs: 15000 }).catch(() => null);
  for (let i = 0; i < config.maxScrolls; i += 1) {
    await ui?.scroll?.({ count: 1, deltaY: 900 + (i % 3) * 180, pauseMs: config.scrollPauseMs }).catch(() => {});
    await sleep(config.scrollPauseMs);
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    if (refreshed?.html) html = refreshed.html;
  }
  if (!html) {
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    html = refreshed?.html || '';
  }
  return html;
}

function parseAliExpressProducts(html, context = {}) {
  const fromCards = parseSearchCards(html, context);
  const byId = new Map();
  for (const item of fromCards) {
    if (item.product_id) byId.set(item.product_id, item);
  }
  for (const item of parseInitDataProducts(html, context)) {
    const existing = item.product_id ? byId.get(item.product_id) : null;
    if (existing) {
      byId.set(item.product_id, {
        ...item,
        ...existing,
        image_url: existing.image_url || item.image_url,
        sold_text: existing.sold_text || item.sold_text,
        sold_count: existing.sold_count || item.sold_count,
        price: existing.price || item.price,
      });
    } else if (item.product_id) {
      byId.set(item.product_id, item);
    }
  }
  return Array.from(byId.values()).map((item, index) => ({
    result_rank: index + 1,
    ...item,
    product_url: normalizeAliUrl(item.product_url),
    image_url: normalizeImageUrl(item.image_url),
    sold_count: numberFromText(item.sold_text || item.sold_count),
    precision_score: scorePrecision(item, context.filter),
    match_reason: matchReasons(item, context.filter).join('|'),
  }));
}

function parseSearchCards(html, context) {
  const items = [];
  const cardRe = /<a\b[^>]*class="[^"]*\bsearch-card-item\b[^"]*"[^>]*>[\s\S]*?(?=<\/a>)/gi;
  let match;
  while ((match = cardRe.exec(html))) {
    const block = match[0];
    const href = decodeHtml(firstMatch(block, /\bhref="([^"]+)"/i));
    const productId = productIdFromUrl(href);
    if (!productId) continue;
    const title = firstClean(block, [
      /<div[^>]*title="([^"]+)"[^>]*class="[^"]*\blk_z\b/i,
      /<div[^>]*class="[^"]*\blk_z\b[^>]*title="([^"]+)"/i,
      /<div[^>]*class="[^"]*\blk_z\b[^>]*aria-label="([^"]+)"/i,
      /aria-label="([^"]+)"/i,
      /<h3\b[^>]*>([\s\S]*?)<\/h3>/i,
      /title="([^"]+)"/i,
    ]);
    const price = firstClean(block, [
      /aria-label="(\$[^"]+)"/i,
      /formattedPrice":"([^"]+)"/i,
    ]) || compactPriceFromCard(block);
    const soldText = firstClean(block, [
      /<span[^>]*class="[^"]*\blk_kn\b[^"]*"[^>]*>([\s\S]*?sold[\s\S]*?)<\/span>/i,
      /"tradeDesc":"([^"]*sold[^"]*)"/i,
    ]);
    const imageUrl = firstUsefulImage(block);
    items.push({
      product_id: productId,
      title,
      price,
      sold_text: soldText,
      sold_count: numberFromText(soldText),
      product_url: href,
      image_url: imageUrl,
      source_url: context.url || '',
    });
  }
  return items;
}

function parseInitDataProducts(html, context) {
  const items = [];
  const seen = new Set();
  const productRe = /"productId":"(\d+)"/g;
  let match;
  while ((match = productRe.exec(html))) {
    const productId = match[1];
    if (seen.has(productId)) continue;
    seen.add(productId);
    const start = Math.max(0, match.index - 2500);
    const end = Math.min(html.length, match.index + 6500);
    const block = html.slice(start, end);
    const title = firstClean(block, [
      /"displayTitle":"((?:\\"|[^"])*)"/,
      /"title":"\{"displayTitle":"((?:\\"|[^"])*)"/,
    ]);
    const imgUrl = firstMatch(block, /"imgUrl":"((?:\\"|[^"])*)"/) ||
      firstMatch(block, /"item_pic_url":"((?:\\"|[^"])*)"/) ||
      firstMatch(block, /"img_url_trace":"((?:\\"|[^"])*)"/);
    const price = firstClean(block, [
      /"formattedPrice":"((?:\\"|[^"])*)"/,
      /"minPrice":([0-9.]+)/,
      /"price":([0-9.]+)/,
    ]);
    const soldText = firstClean(block, [
      /"tradeDesc":"((?:\\"|[^"])*)"/,
      /"real_trade_count":"(\d+)"/,
      /"sold_cnt":"(\d+)"/,
    ]);
    const url = `https://www.aliexpress.com/item/${productId}.html`;
    items.push({
      product_id: productId,
      title,
      price: normalizePrice(price),
      sold_text: normalizeSoldText(soldText),
      sold_count: numberFromText(soldText),
      product_url: url,
      image_url: imgUrl,
      source_url: context.url || '',
    });
  }
  return items;
}

function scorePrecision(item, filter) {
  const text = `${item.title || ''} ${filter || ''}`.toLowerCase();
  let score = 0;
  if (/\bwom[ae]n'?s?\b|lad(y|ies)|female/.test(text)) score += 2;
  if (/\bblazer\b|\bsuit jacket\b|\bsuit coat\b/.test(text)) score += 4;
  if (/double[-\s]?breasted/.test(text)) score += 4;
  if (/gold|metal|lion|button/.test(text)) score += 2;
  if (/lapel|office|elegant|slim|short|small/.test(text)) score += 1;
  return score;
}

function matchReasons(item, filter) {
  const text = `${item.title || ''} ${filter || ''}`.toLowerCase();
  const reasons = [];
  if (/\bwom[ae]n'?s?\b|lad(y|ies)|female/.test(text)) reasons.push('womens');
  if (/\bblazer\b|\bsuit jacket\b|\bsuit coat\b/.test(text)) reasons.push('blazer_jacket');
  if (/double[-\s]?breasted/.test(text)) reasons.push('double_breasted');
  if (/gold|metal|lion|button/.test(text)) reasons.push('gold_or_buttons');
  if (/lapel|office|elegant|slim|short|small/.test(text)) reasons.push('style_shape');
  return reasons;
}

function inferMode(url, config) {
  if (config.query) return 'textSearch';
  if (/isNewImageSearch=y|image_search|imagesearch/i.test(url)) return 'imageSearch';
  return 'imageSearch';
}

function normalizeParams(params) {
  return {
    mode: params.mode || 'auto',
    query: String(params.query || ''),
    filter: String(params.filter || ''),
    maxItems: clampInt(params.maxItems, 1, 200, 50),
    requireSales: params.requireSales !== false,
    minPrecisionScore: clampInt(params.minPrecisionScore, 0, 100, 0),
    maxScrolls: clampInt(params.maxScrolls, 0, 50, 6),
    scrollPauseMs: clampInt(params.scrollPauseMs, 150, 10000, 900),
    pageLoadWaitMs: clampInt(params.pageLoadWaitMs, 0, 30000, 2500),
    actionDelayMs: clampInt(params.actionDelayMs, 150, 5000, 180),
    uploadFile: params.uploadFile || null,
    imageSearchButtonSelector: String(params.imageSearchButtonSelector || '.search--picSearch--3aeyGeH, img[alt="Search by image"]'),
    uploadSelector: String(params.uploadSelector || 'input[type="file"]'),
    uploadWaitMs: clampInt(params.uploadWaitMs, 150, 60000, 6000),
  };
}

function firstUsefulImage(block) {
  const srcs = [];
  const imgRe = /<img\b[^>]*(?:src|data-src)="([^"]+)"/gi;
  let match;
  while ((match = imgRe.exec(block))) srcs.push(decodeHtml(match[1]));
  return srcs.find((src) => /aliexpress-media\.com\/kf\//.test(src) && !/48x48|45x60|27x27/.test(src)) || '';
}

function compactPriceFromCard(block) {
  const aria = firstMatch(block, /aria-label="(\$[0-9][^"]*)"/i);
  if (aria) return decodeHtml(aria);
  const priceBlock = firstMatch(block, /<div[^>]*class="[^"]*\blk_lg\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!priceBlock) return '';
  const parts = [...priceBlock.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => stripTags(m[1])).join('');
  return parts ? parts.trim() : '';
}

function firstClean(text, patterns) {
  for (const pattern of patterns) {
    const value = firstMatch(text, pattern);
    if (value != null && value !== '') return decodeHtml(stripTags(String(value))).replace(/\s+/g, ' ').trim();
  }
  return '';
}

function firstMatch(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1] : '';
}

function stripTags(value) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeAliUrl(url) {
  const decoded = decodeHtml(url);
  if (!decoded) return '';
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (decoded.startsWith('/')) return `https://www.aliexpress.com${decoded}`;
  return decoded;
}

function normalizeImageUrl(url) {
  let decoded = decodeHtml(url);
  if (!decoded) return '';
  if (/^[A-Za-z0-9][A-Za-z0-9_-]+\.(?:jpg|png|webp|jpeg)(?:_|$)/i.test(decoded)) {
    decoded = `//ae-pic-a1.aliexpress-media.com/kf/${decoded}`;
  }
  if (decoded.startsWith('//')) decoded = `https:${decoded}`;
  return decoded;
}

function productIdFromUrl(url) {
  const match = decodeHtml(url).match(/\/item\/(\d+)\.html/);
  return match?.[1] || '';
}

function numberFromText(value) {
  const text = String(value || '');
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)([kKmM]?)/);
  if (!match) return 0;
  const base = Number(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === 'k') return Math.round(base * 1000);
  if (suffix === 'm') return Math.round(base * 1000000);
  return Number.isFinite(base) ? Math.round(base) : 0;
}

function normalizePrice(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d+(?:\.\d+)?$/.test(text)) return `$${text}`;
  return text.replace(/^US\s*/i, '').trim();
}

function normalizeSoldText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/sold/i.test(text)) return text;
  if (/^\d+$/.test(text)) return `${text} sold`;
  return text;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pause(ms) {
  return sleep(Math.max(150, ms || 150));
}
