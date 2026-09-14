import { Hono } from 'hono';
import { beijingParts, isTradingHours } from '../db.js';
import type { IndexItem, IndicesData, KlineRow } from '../types.js';

const indices = new Hono();

// ── 大盘指数内存缓存 ─────────────────────────────────────────
let cachedIndicesData: IndicesData | null = null;
let cachedIndicesTimestamp: number = 0;
let indicesFetchPromise: Promise<IndicesData> | null = null;

async function fetchIndicesDataDirect(): Promise<IndicesData> {
  const symbols = [
    'sh000001', 'sz399001', 'sz399006', 
    'hkHSI', 'hkHSTECH', 'sh518880', 
    'sh000510', 'sh000852', 'sh000688', 'bj899050'
  ];

  const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
  // 并行获取实时指数、国内现货黄金(SGE_AU9999)以及历史K线
  const klineSymbols = ['sh000001', 'sz399001', 'sz399006'];
  const klinePromises = klineSymbols.map((sym: string) => 
    fetch(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=40`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000)
    }).then(r => r.json()).catch(() => [])
  );

  const sgePromise = fetch('https://hq.sinajs.cn/list=SGE_AU9999', {
    headers: {
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(10000),
  }).then(async (r): Promise<IndexItem | null> => {
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const body = new TextDecoder('gbk').decode(buf);
    const match = body.match(/="([^"]+)"/);
    if (!match) return null;
    const fields = match[1].split(',');
    if (fields.length < 10) return null;
    const current = parseFloat(fields[3]) || 0;
    const prevClose = parseFloat(fields[9]) || 0;
    if (current === 0) return null;
    const changeVal = prevClose > 0 ? current - prevClose : 0;
    const changePct = prevClose > 0 ? (changeVal / prevClose) * 100 : 0;
    return {
      symbol: 'SGE_AU9999',
      name: '国内现货黄金',
      current,
      changeVal,
      changePct,
    };
  }).catch(() => null);

  const [resp, sgeData, ...klineResults] = await Promise.all([
    fetch(url, {
      headers: {
        Referer: 'https://gu.qq.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(10000),
    }),
    sgePromise,
    ...klinePromises
  ]) as [Response, IndexItem | null, ...KlineRow[][]];

  if (!resp.ok) throw new Error(`腾讯指数接口 HTTP ${resp.status}`);

  const buf = await resp.arrayBuffer();
  const body = new TextDecoder('gbk').decode(buf);

  const itemsMap: Record<string, IndexItem> = {};
  const priceMap: Record<string, number> = {}; // 用以辅助计算 K 线对比

  for (const entry of body.split(';')) {
    const e = entry.trim();
    if (!e || !e.includes('="')) continue;
    const eqIdx = e.indexOf('="');
    const left = e.slice(0, eqIdx);
    const right = e.slice(eqIdx + 2).replace(/";?\s*$/, '');
    const symbol = left.split('_').pop()!;
    const fields = right.split('~');
    if (fields.length <= 32) continue;

    let name = fields[1].trim();
    if (symbol === 'sh518880') {
      name = '黄金基金';
    } else if (symbol === 'sh000510') {
      name = '中证A500';
    } else if (symbol === 'sh000852') {
      name = '中证1000';
    } else if (symbol === 'sh000688') {
      name = '科创50';
    } else if (symbol === 'bj899050') {
      name = '北证50';
    }
    const current = parseFloat(fields[3]) || 0;
    const changeVal = parseFloat(fields[31]) || 0;
    const changePct = parseFloat(fields[32]) || 0;

    priceMap[symbol] = current;

    itemsMap[symbol] = {
      symbol,
      name,
      current,
      changeVal,
      changePct,
    };
  }

  // 周末或实时接口返回空值时，使用新浪日 K 线最近两个交易日的收盘价
  const isWeekend = [0, 6].includes(beijingParts().day);
  const latestKlineMap: Record<string, { latestClose: number; previousClose: number; latestDate: string }> = {};
  klineSymbols.forEach((sym: string, idx: number) => {
    const rows = (klineResults[idx] || [])
      .filter((row: KlineRow) => row?.day && Number(row.close) > 0)
      .sort((a: KlineRow, b: KlineRow) => a.day.localeCompare(b.day));
    const latest = rows.at(-1);
    const previous = rows.at(-2);
    if (!latest) return;

    const latestClose = Number(latest.close);
    const previousClose = previous ? Number(previous.close) : 0;
    latestKlineMap[sym] = { latestClose, previousClose, latestDate: latest.day };

    if (isWeekend || !itemsMap[sym] || itemsMap[sym].current <= 0) {
      const changeVal = previousClose > 0 ? latestClose - previousClose : 0;
      const changePct = previousClose > 0 ? (changeVal / previousClose) * 100 : 0;
      const existing = itemsMap[sym] || { symbol: sym, name: sym };
      itemsMap[sym] = { ...existing, current: latestClose, changeVal, changePct };
      priceMap[sym] = latestClose;
    }
  });

  if (sgeData) {
    itemsMap['SGE_AU9999'] = sgeData;
  }

  const orderedSymbols = [
    'sh000001', 'sz399001', 'sz399006', 
    'hkHSI', 'hkHSTECH', 'sh518880', 'SGE_AU9999',
    'sh000510', 'sh000852', 'sh000688', 'bj899050'
  ];

  const result = orderedSymbols.map((sym: string) => itemsMap[sym]).filter(Boolean);

  // 计算当月收益率百分比
  const monthChange: Record<string, number> = {};
  const now = beijingParts();
  const curYear = now.year;
  const curMonth = now.month;
  
  // 确定上个月
  const prevYear = curMonth === 1 ? curYear - 1 : curYear;
  const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
  const prevMonthStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

  klineSymbols.forEach((sym: string, idx: number) => {
    const kline = klineResults[idx] || [];
    const currentPrice = (isWeekend ? latestKlineMap[sym]?.latestClose : priceMap[sym]) || 0;
    if (currentPrice === 0 || kline.length === 0) {
      monthChange[sym] = 0.0;
      return;
    }
    
    const prevMonthRows = kline.filter((r: KlineRow) => r.day.startsWith(prevMonthStr));
    let basePrice = 0;
    if (prevMonthRows.length > 0) {
      prevMonthRows.sort((a: KlineRow, b: KlineRow) => a.day.localeCompare(b.day));
      basePrice = parseFloat(prevMonthRows[prevMonthRows.length - 1].close);
    } else {
      const curMonthStr = `${curYear}-${String(curMonth).padStart(2, '0')}`;
      const curMonthRows = kline.filter((r: KlineRow) => r.day.startsWith(curMonthStr));
      if (curMonthRows.length > 0) {
        curMonthRows.sort((a: KlineRow, b: KlineRow) => a.day.localeCompare(b.day));
        basePrice = parseFloat(curMonthRows[0].open);
      }
    }

    if (basePrice > 0) {
      monthChange[sym] = Math.trunc(((currentPrice - basePrice) / basePrice * 100) * 1000) / 1000;
    } else {
      monthChange[sym] = 0.0;
    }
  });

  return { indices: result, month_change: monthChange };
}

async function getIndicesData(): Promise<IndicesData> {
  const trading = isTradingHours();
  const ttl = trading ? 30 * 1000 : 5 * 60 * 1000; // 交易时段 30s，非交易时段 5min
  const now = Date.now();

  if (cachedIndicesData && (now - cachedIndicesTimestamp < ttl)) {
    return cachedIndicesData;
  }

  if (indicesFetchPromise) {
    return indicesFetchPromise;
  }

  indicesFetchPromise = (async () => {
    try {
      const data = await fetchIndicesDataDirect();
      cachedIndicesData = data;
      cachedIndicesTimestamp = Date.now();
      return data;
    } catch (err: unknown) {
      console.warn(`[indices] 抓取失败 (${(err as Error).message})，降级使用最近有效缓存`);
      if (cachedIndicesData) {
        return cachedIndicesData;
      }
      return { indices: [], month_change: {} };
    } finally {
      indicesFetchPromise = null;
    }
  })();

  return indicesFetchPromise;
}

/** GET / — 获取大盘指数行情（上证、深证、创业板、恒生科技、黄金等） */
indices.get('/', async (c) => {
  const data = await getIndicesData();
  return c.json(data);
});

export default indices;
