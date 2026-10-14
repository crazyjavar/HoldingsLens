import { Hono } from 'hono';
import { beijingParts, isTradingHours } from '../db.js';
import { createCachedResource } from '../cache.js';
const indices = new Hono();
// 实时行情每 30 秒（休市 5 分钟）；日 K 线每 15 分钟（休市 1 小时）。
// 黄金和 K 线在已有缓存时后台刷新，不再拖住实时指数。
const klineSymbols = ['sh000001', 'sz399001', 'sz399006'];
const liveSymbols = [
    ...klineSymbols, 'hkHSI', 'hkHSTECH', 'sh518880',
    'sh000510', 'sh000852', 'sh000688', 'bj899050'
];
const getLiveBody = createCachedResource('indices', async () => {
    const resp = await fetch(`https://qt.gtimg.cn/q=${liveSymbols.join(',')}`, {
        headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok)
        throw new Error(`腾讯指数接口 HTTP ${resp.status}`);
    const body = new TextDecoder('gbk').decode(await resp.arrayBuffer());
    if (!body.includes('="'))
        throw new Error('腾讯指数行情为空');
    return body;
}, '');
const getGold = createCachedResource('gold', async () => {
    const r = await fetch('https://hq.sinajs.cn/list=SGE_AU9999', {
        headers: {
            Referer: 'https://finance.sina.com.cn/',
            'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
        throw new Error(`黄金接口 HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const body = new TextDecoder('gbk').decode(buf);
    const match = body.match(/="([^"]+)"/);
    if (!match)
        throw new Error('黄金行情为空');
    const fields = match[1].split(',');
    if (fields.length < 10)
        throw new Error('黄金字段不完整');
    const current = parseFloat(fields[3]) || 0;
    const prevClose = parseFloat(fields[9]) || 0;
    if (current === 0)
        throw new Error('黄金价格无效');
    const changeVal = prevClose > 0 ? current - prevClose : 0;
    const changePct = prevClose > 0 ? (changeVal / prevClose) * 100 : 0;
    return {
        symbol: 'SGE_AU9999',
        name: '国内现货黄金',
        current,
        changeVal,
        changePct,
    };
}, null);
const getKlines = klineSymbols.map(sym => createCachedResource(`kline:${sym}`, async () => {
    const resp = await fetch(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=40`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok)
        throw new Error(`K线接口 HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data))
        throw new Error('K线响应无效');
    const rows = data.filter(row => row?.day && Number(row.close) > 0);
    if (!rows.length)
        throw new Error('K线行情为空');
    return rows;
}, []));
async function getIndicesData() {
    const trading = isTradingHours();
    const nowBj = beijingParts();
    const dateKey = `${nowBj.year}-${nowBj.month}-${nowBj.date}`;
    const liveTtl = trading ? 30_000 : 300_000;
    const klineTtl = trading ? 900_000 : 3_600_000;
    const [body, sgeData, ...klineResults] = await Promise.all([
        getLiveBody(liveTtl, dateKey, true),
        getGold(liveTtl, dateKey),
        ...getKlines.map(get => get(klineTtl, dateKey)),
    ]);
    const itemsMap = {};
    const priceMap = {}; // 用以辅助计算 K 线对比
    for (const entry of body.split(';')) {
        const e = entry.trim();
        if (!e || !e.includes('="'))
            continue;
        const eqIdx = e.indexOf('="');
        const left = e.slice(0, eqIdx);
        const right = e.slice(eqIdx + 2).replace(/";?\s*$/, '');
        const symbol = left.split('_').pop();
        const fields = right.split('~');
        if (fields.length <= 32)
            continue;
        let name = fields[1].trim();
        if (symbol === 'sh518880') {
            name = '黄金基金';
        }
        else if (symbol === 'sh000510') {
            name = '中证A500';
        }
        else if (symbol === 'sh000852') {
            name = '中证1000';
        }
        else if (symbol === 'sh000688') {
            name = '科创50';
        }
        else if (symbol === 'bj899050') {
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
    const latestKlineMap = {};
    klineSymbols.forEach((sym, idx) => {
        const rows = (klineResults[idx] || [])
            .filter((row) => row?.day && Number(row.close) > 0)
            .sort((a, b) => a.day.localeCompare(b.day));
        const latest = rows.at(-1);
        const previous = rows.at(-2);
        if (!latest)
            return;
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
        'hkHSI', 'hkHSTECH', 'SGE_AU9999', 'sh518880',
        'sh000510', 'sh000852', 'sh000688', 'bj899050'
    ];
    const result = orderedSymbols.map((sym) => itemsMap[sym]).filter(Boolean);
    // 计算当月收益率百分比
    const monthChange = {};
    const now = beijingParts();
    const curYear = now.year;
    const curMonth = now.month;
    // 确定上个月
    const prevYear = curMonth === 1 ? curYear - 1 : curYear;
    const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
    const prevMonthStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    klineSymbols.forEach((sym, idx) => {
        const kline = klineResults[idx] || [];
        const currentPrice = (isWeekend ? latestKlineMap[sym]?.latestClose : priceMap[sym]) || 0;
        if (currentPrice === 0 || kline.length === 0) {
            monthChange[sym] = 0.0;
            return;
        }
        const prevMonthRows = kline.filter((r) => r.day.startsWith(prevMonthStr));
        let basePrice = 0;
        if (prevMonthRows.length > 0) {
            prevMonthRows.sort((a, b) => a.day.localeCompare(b.day));
            basePrice = parseFloat(prevMonthRows[prevMonthRows.length - 1].close);
        }
        else {
            const curMonthStr = `${curYear}-${String(curMonth).padStart(2, '0')}`;
            const curMonthRows = kline.filter((r) => r.day.startsWith(curMonthStr));
            if (curMonthRows.length > 0) {
                curMonthRows.sort((a, b) => a.day.localeCompare(b.day));
                basePrice = parseFloat(curMonthRows[0].open);
            }
        }
        if (basePrice > 0) {
            monthChange[sym] = Math.trunc(((currentPrice - basePrice) / basePrice * 100) * 1000) / 1000;
        }
        else {
            monthChange[sym] = 0.0;
        }
    });
    return { indices: result, month_change: monthChange };
}
/** GET / — 获取大盘指数行情（上证、深证、创业板、恒生科技、黄金等） */
indices.get('/', async (c) => {
    const data = await getIndicesData();
    return c.json(data);
});
export default indices;
//# sourceMappingURL=indices.js.map