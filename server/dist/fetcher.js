/**
 * fetcher.ts — 行情抓取模块
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
    if (!str)
        return null;
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
    if (raw.endsWith('.SH'))
        return 'sh' + raw.slice(0, -3);
    if (raw.endsWith('.SZ'))
        return 'sz' + raw.slice(0, -3);
    if (raw.endsWith('.HK'))
        return 'hk' + raw.slice(0, -3);
    if (raw.endsWith('.OF'))
        return 'of' + raw.slice(0, -3);
    throw new Error(`不支持的证券代码: ${code}`);
}
/**
 * 将内部/新浪符号转换为腾讯符号（如 of002708 → s_jj002708）
 */
function toTencentSymbol(sym) {
    if (sym.startsWith('of'))
        return 's_jj' + sym.slice(2);
    return sym;
}
/**
 * 解析新浪行情响应
 */
function parseSinaResponse(body) {
    const prices = {};
    for (const line of body.split('\n')) {
        if (!line.trim() || !line.includes('="'))
            continue;
        const eqIdx = line.indexOf('="');
        const left = line.slice(0, eqIdx);
        const right = line.slice(eqIdx + 2).replace(/";?\s*$/, '');
        const symbol = left.split('_').pop();
        const fields = right.split(',');
        let current = 0;
        let previousClose = 0;
        let lastTradeDate = null;
        let name;
        if ((symbol.startsWith('sh') || symbol.startsWith('sz')) && fields.length > CN_PRICE_FIELD) {
            previousClose = parseFloat(fields[CN_PREV_CLOSE_FIELD]) || 0;
            current = parseFloat(fields[CN_PRICE_FIELD]) || 0;
            if (fields[30] && fields[30].includes('-')) {
                lastTradeDate = fields[30].trim();
            }
        }
        else if (symbol.startsWith('hk') && fields.length > HK_PRICE_FIELD) {
            previousClose = parseFloat(fields[HK_PREV_CLOSE_FIELD]) || 0;
            current = parseFloat(fields[HK_PRICE_FIELD]) || 0;
            const dateField = fields.find(f => /^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(f.trim()));
            if (dateField) {
                lastTradeDate = dateField.trim().replace(/\//g, '-');
            }
        }
        else if (symbol.startsWith('of') && fields.length >= 5) {
            // 新浪场外公募基金：fields[0]=名称, fields[1]=单位净值, fields[2]=累计净值, fields[3]=前一日净值, fields[4]=涨跌幅, fields[5]=公布日期
            name = fields[0]?.trim();
            current = parseFloat(fields[1]) || 0;
            previousClose = parseFloat(fields[3]) || 0;
            if (!previousClose && fields[4]) {
                const pct = parseFloat(fields[4]);
                if (!isNaN(pct) && current > 0)
                    previousClose = current / (1 + pct / 100);
            }
            if (fields[5] && fields[5].includes('-')) {
                lastTradeDate = fields[5].trim();
            }
        }
        else {
            continue;
        }
        if (current > 0) {
            prices[symbol] = { current, previousClose, lastTradeDate, ...(name ? { name } : {}) };
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
        if (!e || !e.includes('="'))
            continue;
        const eqIdx = e.indexOf('="');
        const left = e.slice(0, eqIdx);
        const right = e.slice(eqIdx + 2).replace(/";?\s*$/, '');
        const fields = right.split('~');
        // 基金格式：v_s_jj002708="002708~大摩健康产业混合A~20260916~1.9440~1.9440~1.57~0.0300~..."
        if (left.includes('s_jj') || left.includes('_jj')) {
            if (fields.length < 7)
                continue;
            const fundCode = fields[0].trim();
            const symbolKey = 'of' + fundCode;
            const current = parseFloat(fields[3]) || 0;
            const changeVal = parseFloat(fields[6]) || 0;
            const changePct = parseFloat(fields[5]) || 0;
            let previousClose = current - changeVal;
            if ((!previousClose || previousClose <= 0) && changePct !== 0 && current > 0) {
                previousClose = current / (1 + changePct / 100);
            }
            const tradeDateStr = fields[2] ? parseTradeDate(fields[2]) : null;
            if (current > 0) {
                prices[symbolKey] = {
                    current,
                    previousClose: Math.round(previousClose * 10000) / 10000,
                    lastTradeDate: tradeDateStr,
                    name: fields[1].trim(),
                };
            }
            continue;
        }
        // 股票格式
        const symbol = left.split('_').pop();
        if (fields.length <= TENCENT_PREV_CLOSE_FIELD)
            continue;
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
    if (!resp.ok)
        throw new Error(`新浪行情接口 HTTP ${resp.status}`);
    // 新浪返回 GBK 编码
    const buf = await resp.arrayBuffer();
    const body = new TextDecoder('gbk').decode(buf);
    return parseSinaResponse(body);
}
/**
 * 从腾讯拉取行情
 */
async function fetchFromTencent(symbols) {
    const query = symbols.map(toTencentSymbol).join(',');
    const url = `https://qt.gtimg.cn/q=${encodeURIComponent(query).replace(/%2C/g, ',')}`;
    const resp = await fetch(url, {
        headers: {
            Referer: 'https://gu.qq.com/',
            'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok)
        throw new Error(`腾讯行情接口 HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const body = new TextDecoder('gbk').decode(buf);
    return parseTencentResponse(body);
}
/**
 * 北京时间当前日期字符串 YYYY-MM-DD
 */
function getTodayDate() {
    const t = new Date(Date.now() + 8 * 3600000);
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
/**
 * 从新浪拉取公募基金实时行情（优先盘中估算 fu，晚间官方 of 自动校正）
 */
async function fetchFundPricesFromSina(symbols) {
    if (symbols.length === 0)
        return {};
    const fundCodes = symbols.map(s => s.slice(2)); // of002708 -> 002708
    const query = fundCodes.flatMap(code => [`fu_${code}`, `of${code}`]).join(',');
    const url = `https://hq.sinajs.cn/list=${query}`;
    const resp = await fetch(url, {
        headers: {
            Referer: 'https://finance.sina.com.cn/',
            'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok)
        throw new Error(`新浪基金行情接口 HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const body = new TextDecoder('gbk').decode(buf);
    const today = getTodayDate();
    const fuMap = new Map();
    const ofMap = new Map();
    for (const line of body.split('\n')) {
        if (!line.trim() || !line.includes('="'))
            continue;
        const eqIdx = line.indexOf('="');
        const left = line.slice(0, eqIdx);
        const right = line.slice(eqIdx + 2).replace(/";?\s*$/, '');
        const fields = right.split(',');
        if (fields.length < 5)
            continue;
        if (left.includes('fu_')) {
            const code = left.split('fu_').pop();
            fuMap.set(code, {
                name: fields[0]?.trim(),
                valPrice: parseFloat(fields[2]) || 0,
                prevClose: parseFloat(fields[3]) || 0,
                date: fields[7]?.trim(),
            });
        }
        else if (left.includes('of')) {
            const code = left.split('of').pop();
            let prevClose = parseFloat(fields[3]) || 0;
            const current = parseFloat(fields[1]) || 0;
            if (!prevClose && fields[4]) {
                const pct = parseFloat(fields[4]);
                if (!isNaN(pct) && current > 0)
                    prevClose = current / (1 + pct / 100);
            }
            ofMap.set(code, {
                name: fields[0]?.trim(),
                current,
                prevClose,
                date: fields[5]?.trim(),
            });
        }
    }
    const results = {};
    for (const code of fundCodes) {
        const sym = 'of' + code;
        const fu = fuMap.get(code);
        const of = ofMap.get(code);
        // 1. 若 of 已经发布了今天的官方净值（date === today），以权威官方清算净值为准
        if (of && of.date === today && of.current > 0) {
            results[sym] = {
                current: of.current,
                previousClose: of.prevClose,
                lastTradeDate: of.date || null,
                name: of.name,
            };
            continue;
        }
        // 2. 盘中交易时间或晚间官方净值未出前：优先采用当天的实时估算净值 fu
        if (fu && fu.date === today && fu.valPrice > 0) {
            results[sym] = {
                current: fu.valPrice,
                previousClose: fu.prevClose,
                lastTradeDate: fu.date || null,
                name: fu.name || of?.name,
            };
            continue;
        }
        // 3. 回退到官方最新历史净值 of
        if (of && of.current > 0) {
            results[sym] = {
                current: of.current,
                previousClose: of.prevClose,
                lastTradeDate: of.date || null,
                name: of.name,
            };
        }
    }
    return results;
}
/**
 * 拉取行情：股票走腾讯主/新浪备；公募基金走新浪实时估值主/腾讯备
 * @param symbols - 新浪格式的证券符号列表
 * @returns Promise<Record<string, QuoteResult>>
 */
export async function fetchPrices(symbols) {
    const fundSymbols = symbols.filter(s => s.startsWith('of'));
    const stockSymbols = symbols.filter(s => !s.startsWith('of'));
    const prices = {};
    const errors = [];
    // 并行拉取股票/ETF行情与基金行情
    const [stockQuotes, fundQuotes] = await Promise.all([
        // 股票/ETF: 腾讯主，新浪备
        (async () => {
            if (stockSymbols.length === 0)
                return {};
            const res = {};
            let rem = [...stockSymbols];
            for (const { name, fn } of [
                { name: 'Tencent', fn: fetchFromTencent },
                { name: 'Sina', fn: fetchFromSina },
            ]) {
                if (rem.length === 0)
                    break;
                try {
                    const fetched = await fn(rem);
                    Object.assign(res, fetched);
                    rem = rem.filter(s => !res[s]);
                }
                catch (e) {
                    errors.push(`${name}: ${e.message}`);
                }
            }
            return res;
        })(),
        // 场外公募基金: 新浪实时估值主，腾讯备
        (async () => {
            if (fundSymbols.length === 0)
                return {};
            const res = {};
            let rem = [...fundSymbols];
            for (const { name, fn } of [
                { name: 'SinaFundValuation', fn: fetchFundPricesFromSina },
                { name: 'Tencent', fn: fetchFromTencent },
            ]) {
                if (rem.length === 0)
                    break;
                try {
                    const fetched = await fn(rem);
                    Object.assign(res, fetched);
                    rem = rem.filter(s => !res[s]);
                }
                catch (e) {
                    errors.push(`${name}: ${e.message}`);
                }
            }
            return res;
        })(),
    ]);
    Object.assign(prices, stockQuotes, fundQuotes);
    const remaining = symbols.filter(s => !prices[s]);
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
    if (!resp.ok)
        throw new Error(`汇率接口 HTTP ${resp.status}`);
    const data = await resp.json();
    const rate = Number(data?.rate);
    if (!(rate > 0))
        throw new Error('汇率接口未返回有效 HKD/CNY 汇率');
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
    const query = symbols.map(toTencentSymbol).join(',');
    const url = `https://qt.gtimg.cn/q=${encodeURIComponent(query).replace(/%2C/g, ',')}`;
    const resp = await fetch(url, {
        headers: {
            Referer: 'https://gu.qq.com/',
            'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok)
        throw new Error(`腾讯行情接口 HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const body = new TextDecoder('gbk').decode(buf);
    return parseTencentResponse(body, true);
}
/**
 * 拉取单只证券行情，包含标的名称（自选股添加专用）
 * @param symbol - 新浪格式符号（如 sh600036、of002708）
 * @returns Promise<QuoteResult>
 */
export async function fetchPriceWithName(symbol) {
    // 公募基金：优先新浪盘中估值（带名称），腾讯备选
    if (symbol.startsWith('of')) {
        try {
            const fundRes = await fetchFundPricesFromSina([symbol]);
            if (fundRes[symbol])
                return fundRes[symbol];
        }
        catch (e) { }
        const txRes = await fetchFromTencentWithNames([symbol]);
        if (txRes[symbol])
            return txRes[symbol];
        throw new Error(`未获取到基金行情: ${symbol}`);
    }
    // 股票/ETF: 腾讯主，新浪备
    try {
        const result = await fetchFromTencentWithNames([symbol]);
        if (result[symbol])
            return result[symbol];
    }
    catch (err) { }
    // 腾讯失败则降级新浪
    const result = await fetchFromSina([symbol]);
    if (result[symbol])
        return { ...result[symbol], name: result[symbol].name || '' };
    throw new Error(`未获取到现价: ${symbol}`);
}
//# sourceMappingURL=fetcher.js.map