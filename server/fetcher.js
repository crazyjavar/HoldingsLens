/**
 * fetcher.js — 行情抓取模块
 * 移植自 update_holdings.py，使用 Node 内置 fetch
 * 支持腾讯行情（主）和新浪行情（备用）
 */

// ── 字段索引常量 ──────────────────────────────────────────
const CN_PREV_CLOSE_FIELD = 2;
const CN_PRICE_FIELD = 3;
const HK_PREV_CLOSE_FIELD = 3;
const HK_PRICE_FIELD = 6;
const TENCENT_PRICE_FIELD = 3;
const TENCENT_PREV_CLOSE_FIELD = 4;

/**
 * 规范化解析腾讯/新浪的交易时间戳为 YYYY-MM-DD
 */
function parseTradeDate(str) {
  if (!str) return null;
  const clean = str.trim();
  if (clean.includes('/')) {
    return clean.slice(0, 10).replace(/\//g, '-');
  }
  if (clean.length >= 8 && /^\d+$/.test(clean.slice(0, 8))) {
    return clean.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  }
  return null;
}

/**
 * 将证券代码转换为新浪格式（如 512170.SH → sh512170）
 */
export function sinaSymbol(code) {
  const raw = code.trim();
  if (raw.endsWith('.SH')) return 'sh' + raw.slice(0, -3);
  if (raw.endsWith('.SZ')) return 'sz' + raw.slice(0, -3);
  if (raw.endsWith('.HK')) return 'hk' + raw.slice(0, -3);
  throw new Error(`不支持的证券代码: ${code}`);
}

/**
 * 解析新浪行情响应
 */
function parseSinaResponse(body) {
  const prices = {};
  for (const line of body.split('\n')) {
    if (!line.trim() || !line.includes('="')) continue;
    const eqIdx = line.indexOf('="');
    const left = line.slice(0, eqIdx);
    const right = line.slice(eqIdx + 2).replace(/";?\s*$/, '');
    const symbol = left.split('_').pop();
    const fields = right.split(',');
    let current, previousClose, lastTradeDate = null;
    if ((symbol.startsWith('sh') || symbol.startsWith('sz')) && fields.length > CN_PRICE_FIELD) {
      previousClose = parseFloat(fields[CN_PREV_CLOSE_FIELD]) || 0;
      current = parseFloat(fields[CN_PRICE_FIELD]) || 0;
      if (fields[30] && fields[30].includes('-')) {
        lastTradeDate = fields[30].trim();
      }
    } else if (symbol.startsWith('hk') && fields.length > HK_PRICE_FIELD) {
      previousClose = parseFloat(fields[HK_PREV_CLOSE_FIELD]) || 0;
      current = parseFloat(fields[HK_PRICE_FIELD]) || 0;
      const dateField = fields.find(f => /^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(f.trim()));
      if (dateField) {
        lastTradeDate = dateField.trim().replace(/\//g, '-');
      }
    } else {
      continue;
    }
    if (current > 0) {
      prices[symbol] = { current, previousClose, lastTradeDate };
    }
  }
  return prices;
}

/**
 * 解析腾讯行情响应（含股票名称 fields[1]）
 */
function parseTencentResponse(body, withNames = false) {
  const prices = {};
  for (const entry of body.split(';')) {
    const e = entry.trim();
    if (!e || !e.includes('="')) continue;
    const eqIdx = e.indexOf('="');
    const left = e.slice(0, eqIdx);
    const right = e.slice(eqIdx + 2).replace(/";?\s*$/, '');
    const symbol = left.split('_').pop();
    const fields = right.split('~');
    if (fields.length <= TENCENT_PREV_CLOSE_FIELD) continue;
    const current = parseFloat(fields[TENCENT_PRICE_FIELD]) || 0;
    const previousClose = parseFloat(fields[TENCENT_PREV_CLOSE_FIELD]) || 0;
    if (current > 0) {
      const tradeDateStr = fields[30] ? parseTradeDate(fields[30]) : null;
      prices[symbol] = { current, previousClose, lastTradeDate: tradeDateStr };
      if (withNames && fields[1]) {
        prices[symbol].name = fields[1].trim();
      }
    }
  }
  return prices;
}

/**
 * 从新浪拉取行情
 */
async function fetchFromSina(symbols) {
  const query = symbols.join(',');
  const url = `https://hq.sinajs.cn/list=${encodeURIComponent(query).replace(/%2C/g, ',')}`;
  const resp = await fetch(url, {
    headers: {
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`新浪行情接口 HTTP ${resp.status}`);
  // 新浪返回 GBK 编码
  const buf = await resp.arrayBuffer();
  const body = new TextDecoder('gbk').decode(buf);
  return parseSinaResponse(body);
}

/**
 * 从腾讯拉取行情
 */
async function fetchFromTencent(symbols) {
  const query = symbols.join(',');
  const url = `https://qt.gtimg.cn/q=${encodeURIComponent(query).replace(/%2C/g, ',')}`;
  const resp = await fetch(url, {
    headers: {
      Referer: 'https://gu.qq.com/',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`腾讯行情接口 HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const body = new TextDecoder('gbk').decode(buf);
  return parseTencentResponse(body);
}

/**
 * 拉取行情，腾讯为主，新浪为备用
 * @param {string[]} symbols - 新浪格式的证券符号列表
 * @returns {Promise<Record<string, {current: number, previousClose: number}>>}
 */
export async function fetchPrices(symbols) {
  const sources = [
    { name: 'Tencent', fn: fetchFromTencent },
    { name: 'Sina', fn: fetchFromSina },
  ];
  let remaining = [...symbols];
  const prices = {};
  const errors = [];

  for (const { name, fn } of sources) {
    if (remaining.length === 0) break;
    try {
      const fetched = await fn(remaining);
      Object.assign(prices, fetched);
      remaining = remaining.filter(s => !prices[s]);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  // 完全拿不到任何行情时仍然抛错，避免调用方把当天快照写成空值/0 值。
  if (symbols.length > 0 && remaining.length === symbols.length) {
    const detail = errors.length ? errors.join('; ') : '行情源无数据';
    throw new Error(`未获取到任何现价: ${symbols.join(', ')} (${detail})`);
  }
  // 部分标的行情缺失时降级为“尽力而为”：已拿到的照常返回，缺失的由调用方跳过。
  if (remaining.length > 0) {
    console.warn(`[fetch] 部分标的行情缺失，将跳过: ${remaining.join(', ')} (${errors.join('; ') || '行情源无数据'})`);
  }
  return prices;
}

/**
 * 获取最新 HKD → CNY 参考汇率。
 * Frankfurter 提供无需 API Key 的央行参考汇率聚合接口。
 */
export async function fetchHkdCnyRate() {
  const resp = await fetch('https://api.frankfurter.dev/v2/rate/HKD/CNY', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`汇率接口 HTTP ${resp.status}`);
  const data = await resp.json();
  const rate = Number(data?.rate);
  if (!(rate > 0)) throw new Error('汇率接口未返回有效 HKD/CNY 汇率');
  return {
    rate,
    date: data.date || null,
    source: 'Frankfurter',
  };
}

/**
 * 从腾讯拉取行情（携带股票名称，用于自选股添加）
 */
async function fetchFromTencentWithNames(symbols) {
  const query = symbols.join(',');
  const url = `https://qt.gtimg.cn/q=${encodeURIComponent(query).replace(/%2C/g, ',')}`;
  const resp = await fetch(url, {
    headers: {
      Referer: 'https://gu.qq.com/',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`腾讯行情接口 HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const body = new TextDecoder('gbk').decode(buf);
  return parseTencentResponse(body, true);
}

/**
 * 拉取单只证券行情，包含股票名称（自选股添加专用）
 * @param {string} symbol - 新浪格式符号（如 sh600036）
 * @returns {Promise<{current: number, previousClose: number, name: string}>}
 */
export async function fetchPriceWithName(symbol) {
  try {
    const result = await fetchFromTencentWithNames([symbol]);
    if (result[symbol]) return result[symbol];
  } catch (_) {}
  // 腾讯失败则降级新浪（名称为空，由前端手动输入覆盖）
  const result = await fetchFromSina([symbol]);
  if (result[symbol]) return { ...result[symbol], name: '' };
  throw new Error(`未获取到现价: ${symbol}`);
}
