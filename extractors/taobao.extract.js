// Taobao product search extractor for Agent Browser Runtime.
//
// Modes:
// - imageSearch: upload a reference image through Taobao's visible image-search UI,
//   then extract product cards from the result page.
// - textSearch: type a query into Taobao search, then extract product cards.
// - auto: infer mode from URL and params.
//
// Usage from the Agent Browser Runtime repo:
//   ./cli/brs.js extract taobao.extract.js \
//     'https://www.taobao.com/' \
//     --params '{"mode":"imageSearch","maxItems":40,"requireSales":true,"filter":"女士 双排扣 金扣 西装外套"}' \
//     --file /absolute/path/to/reference-image.png \
//     --agent codex --task taobao-image-search --humanize standard --active true --save-html

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
    searchInputSelector: {
      type: 'string',
      default: '#q, input[name="q"], input[placeholder*="搜索"], input[type="search"]',
    },
    searchButtonSelector: {
      type: 'string',
      default: 'button[type="submit"], .btn-search, [class*="search-button"], [aria-label*="搜索"]',
    },
    imageSearchButtonSelector: {
      type: 'string',
      default: '[aria-label*="图片"], [title*="图片"], [class*="camera"], [class*="image"], input[type="file"]',
    },
    uploadSelector: { type: 'string', default: 'input[type="file"]' },
    uploadWaitMs: { type: 'integer', default: 7000 },
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
  const parsed = parseTaobaoProducts(html, { url: targetUrl, filter: config.filter || config.query });
  const filtered = parsed
    .map((item, index) => ({
      ...item,
      source: 'taobao',
      mode,
      result_rank: item.result_rank || index + 1,
    }))
    .filter((item) => !config.requireSales || item.sold_count > 0 || hasSalesText(item.sales_text))
    .filter((item) => item.precision_score >= config.minPrecisionScore)
    .slice(0, config.maxItems);

  return {
    source: 'taobao',
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
      loginOrChallengeDetected: detectLoginOrChallenge(html),
    },
  };
}

async function runTextSearch(ui, config) {
  if (!config.query) throw new Error('textSearch mode requires params.query');
  await ui?.waitFor?.({ selector: config.searchInputSelector, timeoutMs: 15000 }).catch(() => null);
  await pause(config.actionDelayMs);
  await ui?.click?.({ selector: config.searchInputSelector, pauseAfterMs: config.actionDelayMs });
  await pause(config.actionDelayMs);
  await ui?.type?.({
    selector: config.searchInputSelector,
    text: config.query,
    minDelayMs: config.actionDelayMs,
    maxDelayMs: config.actionDelayMs + 120,
    pauseAfterMs: config.actionDelayMs,
  });
  await pause(config.actionDelayMs);
  await ui?.press?.({ key: 'Enter', pauseAfterMs: Math.max(config.actionDelayMs, 600) }).catch(async () => {
    await ui?.click?.({ selector: config.searchButtonSelector, pauseAfterMs: Math.max(config.actionDelayMs, 600) });
  });
  await sleep(4000);
}

async function runImageSearchUpload(ui, config) {
  if (!ui?.uploadFile) throw new Error('imageSearch mode requires runtime ui.uploadFile support');
  await ui?.waitFor?.({ selector: config.imageSearchButtonSelector, timeoutMs: 15000 }).catch(() => null);
  await pause(config.actionDelayMs);
  await ui?.click?.({ selector: config.imageSearchButtonSelector, pauseAfterMs: config.actionDelayMs }).catch(() => null);
  await pause(config.actionDelayMs);
  await ui?.waitFor?.({ selector: config.uploadSelector, timeoutMs: 12000 }).catch(() => null);
  await ui.uploadFile({
    selector: config.uploadSelector,
    file: config.uploadFile,
    pauseAfterMs: config.actionDelayMs,
  });
  await sleep(config.uploadWaitMs);
}

async function collectResultsHtml({ pageHtml, ui, config }) {
  let html = pageHtml || '';
  await ui?.waitFor?.({
    selector: 'a[href*="item.taobao.com"], a[href*="detail.tmall.com"], [class*="item"], body',
    timeoutMs: 18000,
  }).catch(() => null);

  for (let i = 0; i < config.maxScrolls; i += 1) {
    await ui?.scroll?.({ count: 1, deltaY: 850 + (i % 3) * 180, pauseMs: config.scrollPauseMs }).catch(() => {});
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

function parseTaobaoProducts(html, context = {}) {
  const byId = new Map();
  for (const item of parseProductWindows(html, context)) {
    if (item.product_id) byId.set(item.product_id, item);
  }
  for (const item of parseRenderedCards(html, context)) {
    const existing = item.product_id ? byId.get(item.product_id) : null;
    if (existing) {
      byId.set(item.product_id, {
        ...existing,
        ...item,
        title: item.title || existing.title,
        price: item.price || existing.price,
        sales_text: item.sales_text || existing.sales_text,
        image_url: item.image_url || existing.image_url,
        shop_name: item.shop_name || existing.shop_name,
      });
    } else if (item.product_id) {
      byId.set(item.product_id, item);
    }
  }

  return Array.from(byId.values()).map((item, index) => {
    const productUrl = normalizeTaobaoUrl(item.product_url, item.product_id, item.host);
    const salesText = normalizeSalesText(item.sales_text);
    return {
      result_rank: index + 1,
      product_id: item.product_id,
      title: item.title || '',
      price: normalizePrice(item.price),
      sales_text: salesText,
      sold_count: numberFromText(salesText),
      shop_name: item.shop_name || '',
      product_url: productUrl,
      image_url: normalizeImageUrl(item.image_url),
      source_url: context.url || '',
      precision_score: scorePrecision(item, context.filter),
      match_reason: matchReasons(item, context.filter).join('|'),
    };
  });
}

function parseProductWindows(html, context) {
  void context;
  const items = [];
  const seen = new Set();
  const idRe = /(?:item\.taobao\.com\/item\.htm|detail\.tmall\.com\/item\.htm|["'](?:itemId|nid|auctionId|item_id|itemID)["']\s*:\s*["']?)(?:[^"'<>]*?[?&]id=)?(\d{8,})/gi;
  let match;
  while ((match = idRe.exec(html))) {
    const productId = match[1];
    if (seen.has(productId)) continue;
    seen.add(productId);
    const start = Math.max(0, match.index - 3500);
    const end = Math.min(html.length, match.index + 9000);
    const block = html.slice(start, end);
    const host = /detail\.tmall\.com/.test(block) ? 'tmall' : 'taobao';
    items.push({
      product_id: productId,
      host,
      title: cleanText(firstClean(block, [
        /"raw_title"\s*:\s*"((?:\\"|[^"])*)"/i,
        /"title"\s*:\s*"((?:\\"|[^"])*)"/i,
        /"itemTitle"\s*:\s*"((?:\\"|[^"])*)"/i,
        /"shortTitle"\s*:\s*"((?:\\"|[^"])*)"/i,
        /title="([^"]{4,200})"/i,
        /alt="([^"]{4,200})"/i,
      ])),
      price: firstClean(block, [
        /"view_price"\s*:\s*"([^"]+)"/i,
        /"price"\s*:\s*"?(¥?\d+(?:\.\d+)?)"?/i,
        /"salePrice"\s*:\s*"?(¥?\d+(?:\.\d+)?)"?/i,
        /¥\s*(\d+(?:\.\d+)?)/i,
      ]),
      sales_text: firstClean(block, [
        /"view_sales"\s*:\s*"([^"]+)"/i,
        /"realSales"\s*:\s*"([^"]+)"/i,
        /"sold"\s*:\s*"([^"]+)"/i,
        /((?:\d+(?:\.\d+)?万?\+?)\s*(?:人付款|付款|人收货|已售|销量|笔成交|评价))/i,
      ]),
      shop_name: cleanText(firstClean(block, [
        /"nick"\s*:\s*"((?:\\"|[^"])*)"/i,
        /"shopName"\s*:\s*"((?:\\"|[^"])*)"/i,
        /"sellerNick"\s*:\s*"((?:\\"|[^"])*)"/i,
      ])),
      product_url: firstMatch(block, /(https?:)?\/\/(?:item\.taobao\.com\/item\.htm|detail\.tmall\.com\/item\.htm)[^"'<>\\]+/i),
      image_url: firstClean(block, [
        /"pic_url"\s*:\s*"((?:\\"|[^"])*)"/i,
        /"picUrl"\s*:\s*"((?:\\"|[^"])*)"/i,
        /"image"\s*:\s*"((?:\\"|[^"])*)"/i,
        /<img[^>]+(?:src|data-src)="([^"]+)"/i,
      ]),
    });
  }
  return items;
}

function parseRenderedCards(html, context) {
  void context;
  const items = [];
  const cardRe = /<a\b[^>]+href="([^"]*(?:item\.taobao\.com\/item\.htm|detail\.tmall\.com\/item\.htm)[^"]*)"[^>]*>[\s\S]{0,8000}?<\/a>/gi;
  let match;
  while ((match = cardRe.exec(html))) {
    const href = decodeHtml(match[1]);
    const productId = productIdFromUrl(href);
    if (!productId) continue;
    const block = match[0];
    const text = cleanText(stripTags(block));
    items.push({
      product_id: productId,
      host: /detail\.tmall\.com/.test(href) ? 'tmall' : 'taobao',
      product_url: href,
      title: firstClean(block, [
        /title="([^"]{4,200})"/i,
        /alt="([^"]{4,200})"/i,
        /aria-label="([^"]{4,200})"/i,
      ]) || guessTitleFromText(text),
      price: firstClean(block, [/¥\s*(\d+(?:\.\d+)?)/i]) || firstMatch(text, /¥\s*(\d+(?:\.\d+)?)/i),
      sales_text: firstMatch(text, /(\d+(?:\.\d+)?万?\+?\s*(?:人付款|付款|人收货|已售|销量|笔成交|评价))/i),
      shop_name: '',
      image_url: firstUsefulImage(block),
    });
  }
  return items;
}

function scorePrecision(item, filter) {
  const text = `${item.title || ''} ${filter || ''}`.toLowerCase();
  let score = 0;
  if (/女|女士|女装|women|woman|ladies|lady/.test(text)) score += 2;
  if (/西装|小西服|西服|blazer|suit jacket|suit coat/.test(text)) score += 4;
  if (/双排扣|双排|double[-\s]?breasted/.test(text)) score += 4;
  if (/金扣|金色扣|纽扣|扣子|gold|button|metal/.test(text)) score += 2;
  if (/外套|短外套|修身|通勤|气质|高级|休闲|lapel|office|elegant|slim|short/.test(text)) score += 1;
  return score;
}

function matchReasons(item, filter) {
  const text = `${item.title || ''} ${filter || ''}`.toLowerCase();
  const reasons = [];
  if (/女|女士|女装|women|woman|ladies|lady/.test(text)) reasons.push('women');
  if (/西装|小西服|西服|blazer|suit jacket|suit coat/.test(text)) reasons.push('blazer');
  if (/双排扣|双排|double[-\s]?breasted/.test(text)) reasons.push('double_breasted');
  if (/金扣|金色扣|纽扣|扣子|gold|button|metal/.test(text)) reasons.push('gold_buttons');
  if (hasSalesText(item.sales_text)) reasons.push('sales_visible');
  if (!reasons.length) reasons.push('weak_title_match');
  return reasons;
}

function normalizeParams(params) {
  return {
    mode: params.mode || 'auto',
    query: params.query || '',
    filter: params.filter || '',
    maxItems: Number(params.maxItems || 50),
    requireSales: params.requireSales !== false,
    minPrecisionScore: Number(params.minPrecisionScore || 0),
    maxScrolls: Number(params.maxScrolls || 6),
    scrollPauseMs: Number(params.scrollPauseMs || 900),
    pageLoadWaitMs: Number(params.pageLoadWaitMs || 2500),
    actionDelayMs: Number(params.actionDelayMs || 180),
    uploadFile: params.uploadFile,
    searchInputSelector: params.searchInputSelector || schema.properties.searchInputSelector.default,
    searchButtonSelector: params.searchButtonSelector || schema.properties.searchButtonSelector.default,
    imageSearchButtonSelector: params.imageSearchButtonSelector || schema.properties.imageSearchButtonSelector.default,
    uploadSelector: params.uploadSelector || schema.properties.uploadSelector.default,
    uploadWaitMs: Number(params.uploadWaitMs || 7000),
  };
}

function inferMode(url, config) {
  if (config.query) return 'textSearch';
  if (config.uploadFile || /image|pic|img|pailitao|soutu|search_type=itemimage/i.test(url)) return 'imageSearch';
  return 'textSearch';
}

function normalizeTaobaoUrl(url, productId, host = 'taobao') {
  const id = productId || productIdFromUrl(url);
  if (!id) return normalizeUrl(url);
  const domain = host === 'tmall' || /detail\.tmall\.com/.test(String(url || '')) ? 'detail.tmall.com' : 'item.taobao.com';
  return `https://${domain}/item.htm?id=${id}`;
}

function productIdFromUrl(url) {
  return String(url || '').match(/[?&]id=(\d{8,})/)?.[1] || '';
}

function normalizeImageUrl(url) {
  let value = decodeJsonString(String(url || '').trim());
  if (!value) return '';
  value = value.replace(/\\\//g, '/');
  if (value.startsWith('//')) value = `https:${value}`;
  if (value.startsWith('http://')) value = value.replace(/^http:/, 'https:');
  return value;
}

function normalizeUrl(url) {
  const value = decodeHtml(String(url || '').trim());
  if (!value) return '';
  return value.startsWith('//') ? `https:${value}` : value;
}

function normalizePrice(value) {
  const text = decodeJsonString(String(value || '')).replace(/\s+/g, '');
  if (!text) return '';
  if (text.startsWith('¥') || text.startsWith('￥')) return text.replace('￥', '¥');
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? `¥${match[0]}` : text;
}

function normalizeSalesText(value) {
  const text = cleanText(value);
  if (!text) return '';
  return text.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function numberFromText(value) {
  const text = String(value || '').replace(/,/g, '');
  const match = text.match(/(\d+(?:\.\d+)?)(万)?/);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (match[2] ? 10000 : 1));
}

function hasSalesText(value) {
  return /(付款|已售|销量|成交|评价|人收货|sold)/i.test(String(value || '')) && /\d/.test(String(value || ''));
}

function firstUsefulImage(block) {
  const imgRe = /(?:src|data-src|data-ks-lazyload|data-img)="([^"]+)"/gi;
  let match;
  while ((match = imgRe.exec(block))) {
    const url = normalizeImageUrl(match[1]);
    if (/alicdn|tbcdn|taobao|tmall/.test(url) && !/sprite|icon|logo/i.test(url)) return url;
  }
  return '';
}

function firstClean(text, patterns) {
  for (const pattern of patterns) {
    const value = firstMatch(text, pattern);
    if (value) return cleanText(value);
  }
  return '';
}

function firstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  return match?.[1] ? decodeHtml(decodeJsonString(match[1])) : '';
}

function decodeJsonString(value) {
  const text = String(value || '');
  if (!/[\\"]/.test(text)) return text;
  try {
    return JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
  } catch (_) {
    return text.replace(/\\"/g, '"').replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(value) {
  return decodeHtml(decodeJsonString(String(value || '')))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function guessTitleFromText(text) {
  const parts = cleanText(text).split(/\s{2,}|¥|付款|已售|销量|评价/).map((s) => s.trim()).filter(Boolean);
  return parts.find((part) => part.length >= 4 && !/^\d/.test(part)) || '';
}

function detectLoginOrChallenge(html) {
  return /login|登录|验证|验证码|安全检测|滑块|punish|captcha|baxia/i.test(String(html || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function pause(ms) {
  await sleep(ms);
}
