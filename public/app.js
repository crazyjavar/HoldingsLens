// ── 格式化工具 ─────────────────────────────────────────
    const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
    const moneyFormatter  = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 });
    const priceFormatter  = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 4 });

    function formatPercent(value) {
      return `${Number(value).toFixed(2)}%`;
    }

    function formatDayPercent(value) {
      const num = typeof value === 'string' ? toNum(value) : Number(value);
      const factor = 1000;
      const truncated = Math.trunc(num * factor) / factor;
      return `${truncated.toFixed(3)}%`;
    }

    function toNum(str) {
      if (!str || str === '-') return 0;
      return parseFloat(String(str).replace(/[%,]/g, '')) || 0;
    }

    // 所有写入 innerHTML 的外部数据必须先转义，同时适用于文本和引号包裹的属性值。
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
      })[char]);
    }

    function classify(name, code) {
      if (name.includes('医疗') || name.includes('医药')) return '医药健康';
      if (name.includes('互联') || name.includes('互联网') || name.includes('恒指科技')) return '互联网科技ETF';
      if (code.endsWith('.HK') || name.includes('-W')) return '港股个股';
      if (name.includes('证券')) return '金融ETF';
      return '其他';
    }

    // ── 动画化工具 ───────────────────────────────────────────
    function animateNumericKpi(elementId, targetVal, startVal = 0, isPercent = false, prefix = '', isDayPercent = false) {
      const el = document.getElementById(elementId);
      if (!el) return;
      const formatFn = isPercent ? (isDayPercent ? formatDayPercent : formatPercent) : moneyFormatter.format.bind(moneyFormatter);
      if (typeof gsap === 'undefined') {
        const valStr = formatFn(targetVal);
        el.textContent = prefix + valStr;
        return;
      }
      if (Math.abs(targetVal - startVal) < 0.001 && targetVal !== 0 && startVal !== 0) {
        const valStr = formatFn(targetVal);
        el.textContent = prefix + valStr;
        return;
      }
      const obj = { value: startVal };
      gsap.to(obj, {
        value: targetVal,
        duration: 0.8,
        ease: "power2.out",
        overwrite: "auto",
        onUpdate: () => {
          const valStr = formatFn(obj.value);
          el.textContent = prefix + valStr;
        }
      });
    }

    // ── 状态 ────────────────────────────────────────────────
    const state = {
      holdings: [],
      summary: null,
      filter: 'all',
      search: '',
      sort: 'weight-desc',
      // 使用足够大的数值保持与旧版后端兼容：旧版会截断为 365，新版可返回完整多年数据。
      historyDays: 5000,
      historyGranularity: 'day',
      historyPnlMode: 'amt',
      historyViewMode: 'calendar',
      historyData: null,
      comparePeriod: 'day',
      indicesMonthChange: null,
      indicesLive: [],
      hideValues: false,
      effectMode: 'daily',
      weekModeInitialized: false,
      prevValues: {
        totalMarket: 0,
        totalPnl: 0,
        totalPnlRate: 0,
        dayPnl: 0,
        dayPnlRate: 0,
        monthPnl: 0,
        monthPnlRate: 0,
        topWeight: 0,
        top3Weight: 0
      }
    };

    // ── 数据加载 ─────────────────────────────────────────────
    // ── 加载并渲染大盘指数 ───────────────────────────────────────
    async function loadIndices() {
      const indexBar = document.getElementById('indexBar');
      if (!indexBar) return;
      try {
        const resp = await fetch('/api/indices');
        if (!resp.ok) throw new Error(`API ${resp.status}`);
        const data = await resp.json();
        const indices = data.indices || [];
        
        // 缓存数据
        state.indicesLive = indices;
        state.indicesMonthChange = data.month_change || null;
        
        // 渲染对比大盘卡片
        renderComparePanel();

        if (indices.length === 0) {
          indexBar.innerHTML = '';
          return;
        }
        indexBar.innerHTML = indices.map(idx => {
          const isUp = idx.changeVal > 0;
          const isDown = idx.changeVal < 0;
          const sign = isUp ? '+' : '';
          const changeClass = isUp ? 'positive' : (isDown ? 'negative' : 'flat');
          // 精准保留两位小数
          const currentStr = idx.current.toFixed(2);
          const valStr = idx.changeVal.toFixed(2);
          const pctStr = idx.changePct.toFixed(2);
          
          return `
            <div class="index-card">
              <div class="index-card-header">
                <span class="index-name">${escapeHtml(idx.name)}</span>
              </div>
              <div class="index-value">${currentStr}</div>
              <div class="index-change-row ${changeClass}">
                <span>${sign}${valStr}</span>
                <span>${sign}${pctStr}%</span>
              </div>
            </div>
          `;
        }).join('');
      } catch (err) {
        console.error('Failed to load indices:', err);
      }
    }

    // ── 渲染跑赢大盘对比卡片 ──────────────────────────────────────────
    function renderComparePanel() {
      const live = state.indicesLive || [];
      const monthChange = state.indicesMonthChange || {};
      const isDay = state.comparePeriod === 'day';

      // 1. 获取“我”的收益率
      let myVal = 0.0;
      if (isDay) {
        myVal = state.summary ? toNum(state.summary.total_day_pct) : 0;
      } else {
        myVal = state.summary ? toNum(state.summary.month_pnl_pct) : 0;
      }

      // 2. 获取大盘三指数收益率
      const getLivePct = sym => {
        const found = live.find(x => x.symbol === sym);
        return found ? found.changePct : 0.0;
      };
      
      const shVal = isDay ? getLivePct('sh000001') : (monthChange['sh000001'] ?? 0.0);
      const szVal = isDay ? getLivePct('sz399001') : (monthChange['sz399001'] ?? 0.0);
      const cyVal = isDay ? getLivePct('sz399006') : (monthChange['sz399006'] ?? 0.0);

      // 3. 计算跑赢幅度 (对比上证)
      const diff = myVal - shVal;
      const sign = diff >= 0 ? '+' : '';
      const heroValEl = document.getElementById('compareHeroValue');
      const heroLabelEl = document.getElementById('compareHeroLabel');

      if (heroLabelEl) {
        heroLabelEl.textContent = isDay ? '今日跑赢上证指数' : '本月跑赢上证指数';
      }
      if (heroValEl) {
        heroValEl.textContent = `${sign}${diff.toFixed(3)}%`;
        heroValEl.className = `compare-hero-value ${diff >= 0 ? 'positive' : 'negative'}`;
      }

      // 4. 计算对称双向条形图进度条宽度
      const vals = [myVal, shVal, szVal, cyVal];
      const maxAbs = Math.max(...vals.map(Math.abs), 1.0); // 确定最大绝对值上限

      const updateBar = (barId, valId, val) => {
        const bar = document.getElementById(barId);
        const valText = document.getElementById(valId);
        if (!bar || !valText) return;

        const ratio = (val / maxAbs) * 100; // 范围 [-100, 100]
        const width = Math.abs(ratio) / 2; // 正中 0 点，最大占 50% 宽度

        if (ratio >= 0) {
          bar.style.left = '50%';
          bar.style.width = `${width}%`;
          bar.className = 'bar-fill positive';
        } else {
          bar.style.left = `${50 - width}%`;
          bar.style.width = `${width}%`;
          bar.className = 'bar-fill negative';
        }

        const vSign = val >= 0 ? '+' : '';
        valText.textContent = `${vSign}${val.toFixed(2)}%`;
        valText.className = `bar-value ${val >= 0 ? 'positive' : 'negative'}`;
      };

      updateBar('myBar', 'myValue', myVal);
      updateBar('shBar', 'shValue', shVal);
      updateBar('szBar', 'szValue', szVal);
      updateBar('cyBar', 'cyValue', cyVal);
    }

    async function loadLatest(isSilent = false) {
      const resp = await fetch('/api/holdings/latest');
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      const data = await resp.json();

      state.holdings = (data.holdings || []).map(row => ({
        date:        row.date,
        name:        row.name,
        code:        row.code,
        marketValue: row.market,
        costPrice:   row.cost ?? '-',
        previousClose: row.prev_close ?? '-',
        currentPrice: row.price,
        quantity:    row.quantity,
        dayPnl:      row.day_pnl ?? 0,
        dayPnlRate:  toNum(row.day_pnl_pct),
        pnl:         row.total_pnl ?? 0,
        pnlRate:     toNum(row.total_pnl_pct),
        weight:      toNum(row.weight),
        category:    classify(row.name, row.code),
        change:      row.change_pct || '-',
      }));

      state.summary = data.summary;
      document.getElementById('sourceState').textContent = 'API 实时数据';
      render(isSilent);
    }

    async function loadHistory(days = 5000) {
      const resp = await fetch(`/api/holdings/history?days=${days}`);
      if (!resp.ok) return;
      const data = await resp.json();
      state.historyData = data.history || [];
      renderHistoryChart(state.historyData);
    }

    // ── KPI 渲染 ──────────────────────────────────────────────
    function renderKpis(isSilent = false) {
      const h = state.holdings;
      const s = state.summary;

      const totalMarket  = s ? s.total_market  : h.reduce((a, x) => a + x.marketValue, 0);
      const totalDayPnl  = s ? s.total_day_pnl : h.reduce((a, x) => a + x.dayPnl, 0);
      const totalDayRate = s ? toNum(s.total_day_pct) : 0;
      const totalPnl     = s ? s.total_pnl     : h.reduce((a, x) => a + x.pnl, 0);
      const totalRate    = s ? toNum(s.total_pnl_pct) : 0;

      const sorted = [...h].sort((a, b) => b.weight - a.weight);
      const top    = sorted[0] || { weight: 0, name: '-' };
      const top3   = sorted.slice(0, 3).reduce((a, x) => a + x.weight, 0);
      const gains  = h.filter(x => x.pnl >= 0).length;

      // 如果是隐藏数值模式
      if (state.hideValues) {
        document.getElementById('totalMarket').textContent = '¥****';
        
        const pnlEl = document.getElementById('totalPnl');
        pnlEl.textContent = '¥****';
        pnlEl.className   = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
        document.getElementById('totalPnlRate').textContent = `组合收益率 ${formatPercent(totalRate)}`;

        const dayEl = document.getElementById('dayPnl');
        dayEl.textContent = '¥****';
        dayEl.className   = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
        document.getElementById('dayPnlRate').textContent = `相对昨收 ${formatDayPercent(totalDayRate)}`;

        const monthPnl     = s ? (s.month_pnl ?? 0) : 0;
        const monthPnlRate = s ? toNum(s.month_pnl_pct) : 0;
        const monthEl = document.getElementById('monthPnl');
        monthEl.textContent = '¥****';
        monthEl.className   = `kpi-value ${monthPnl >= 0 ? 'positive' : 'negative'}`;
        document.getElementById('monthPnlRate').textContent = `本月累计 ${formatPercent(monthPnlRate)}`;

        document.getElementById('topWeight').textContent  = formatPercent(top.weight);
        document.getElementById('top3Weight').textContent = formatPercent(top3);
      } else if (isSilent) {
        // 如果是静默更新
        document.getElementById('totalMarket').textContent = moneyFormatter.format(totalMarket);
        
        const pnlEl = document.getElementById('totalPnl');
        pnlEl.textContent = moneyFormatter.format(totalPnl);
        pnlEl.className   = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
        document.getElementById('totalPnlRate').textContent = `组合收益率 ${formatPercent(totalRate)}`;

        const dayEl = document.getElementById('dayPnl');
        dayEl.textContent = moneyFormatter.format(totalDayPnl);
        dayEl.className   = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
        document.getElementById('dayPnlRate').textContent = `相对昨收 ${formatDayPercent(totalDayRate)}`;

        const monthPnl     = s ? (s.month_pnl ?? 0) : 0;
        const monthPnlRate = s ? toNum(s.month_pnl_pct) : 0;
        const monthEl = document.getElementById('monthPnl');
        monthEl.textContent = moneyFormatter.format(monthPnl);
        monthEl.className   = `kpi-value ${monthPnl >= 0 ? 'positive' : 'negative'}`;
        document.getElementById('monthPnlRate').textContent = `本月累计 ${formatPercent(monthPnlRate)}`;

        document.getElementById('topWeight').textContent  = formatPercent(top.weight);
        document.getElementById('top3Weight').textContent = formatPercent(top3);
      } else {
        // 使用 GSAP 数字滚动动画
        const prev = state.prevValues || {
          totalMarket: 0, totalPnl: 0, totalPnlRate: 0,
          dayPnl: 0, dayPnlRate: 0, monthPnl: 0, monthPnlRate: 0,
          topWeight: 0, top3Weight: 0
        };
        
        animateNumericKpi('totalMarket', totalMarket, prev.totalMarket);
        
        const pnlEl = document.getElementById('totalPnl');
        pnlEl.className = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
        animateNumericKpi('totalPnl', totalPnl, prev.totalPnl);
        animateNumericKpi('totalPnlRate', totalRate, prev.totalPnlRate, true, '组合收益率 ');

        const dayEl = document.getElementById('dayPnl');
        dayEl.className = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
        animateNumericKpi('dayPnl', totalDayPnl, prev.dayPnl);
        animateNumericKpi('dayPnlRate', totalDayRate, prev.dayPnlRate, true, '相对昨收 ', true);

        const monthPnl     = s ? (s.month_pnl ?? 0) : 0;
        const monthPnlRate = s ? toNum(s.month_pnl_pct) : 0;
        const monthEl = document.getElementById('monthPnl');
        monthEl.className = `kpi-value ${monthPnl >= 0 ? 'positive' : 'negative'}`;
        animateNumericKpi('monthPnl', monthPnl, prev.monthPnl);
        animateNumericKpi('monthPnlRate', monthPnlRate, prev.monthPnlRate, true, '本月累计 ');

        animateNumericKpi('topWeight', top.weight, prev.topWeight, true);
        animateNumericKpi('top3Weight', top3, prev.top3Weight, true);
      }

      // 无论静默与否，直接渲染非数字滚动内容及保存状态
      document.getElementById('holdingCount').textContent = `${h.length} 个持仓标的`;
      document.getElementById('topHolding').textContent = top.name;
      document.getElementById('gainCount').textContent  = `${gains} 个`;
      document.getElementById('lossCount').textContent  = `${h.length - gains} 个`;

      const date = h[0]?.date || '--';
      document.getElementById('asOf').textContent    = date;
      document.getElementById('subtitle').textContent = state.hideValues ?
        `截至 ${date}，组合总市值 ****，当日盈亏 ****，累计盈亏 ****。` :
        `截至 ${date}，组合总市值 ${moneyFormatter.format(totalMarket)}，当日盈亏 ${moneyFormatter.format(totalDayPnl)}，累计盈亏 ${moneyFormatter.format(totalPnl)}。`;

      // 保存本次的值供下次作为起点
      state.prevValues = {
        totalMarket,
        totalPnl,
        totalPnlRate: totalRate,
        dayPnl: totalDayPnl,
        dayPnlRate: totalDayRate,
        monthPnl: s ? (s.month_pnl ?? 0) : 0,
        monthPnlRate: s ? toNum(s.month_pnl_pct) : 0,
        topWeight: top.weight,
        top3Weight: top3
      };

      renderEffect(totalRate, totalDayPnl, s);
      renderComparePanel();
    }

    // ── AI 助理效果 ───────────────────────────────────────────
    const cutePhrases = [
      '主人不要灰心嘛~ 贴贴你~ (｡♥‿♥｡)',
      '喵呜~ 虽然这次跌了，但本喵会一直陪着你的！',
      '摸摸头，仓位稳住，我们下次一定会涨回来！',
      '哼，市场坏坏！不哭不哭，有我给你抱抱！(つ✧ω✧)つ',
      '主人最棒啦，本小动物给你打气，加把劲呀！',
    ];
    const dominatePhrases = [
      '至高主宰！收益率制霸全场，顺我者涨！',
      '雄霸天下，无可匹敌！整个市场都在为我颤抖！',
      '哈哈，本座的账户大刀早已饥渴难耐了！',
      '看我气吞万里如虎，这点涨幅只是开始！',
      '主宰一切！让利润如狂澜般飞舞吧！',
    ];

    let canvasAnimationId = null;
    let textBubbleInterval = null;

    function animateEffectSwitch() {
      if (typeof gsap === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo(
        ['#effectStage', '#effectBubble'],
        { autoAlpha: 0, y: 8 },
        { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.06, ease: 'power2.out', overwrite: 'auto', clearProps: 'all' }
      );
    }

    function renderEffect(totalRate, dayPnl, summary) {
      const isWinning = dayPnl >= 0;
      const titleEl   = document.getElementById('effectTitle');
      const noteEl    = document.getElementById('effectNote');
      const bubbleEl  = document.getElementById('effectBubble');
      const animalEl  = document.getElementById('cuteAnimalContainer');
      const winningImg = document.getElementById('winningImg');
      const switchEl = document.getElementById('effectSwitch');
      const weeklyEl = document.getElementById('weeklyReport');
      const weekReady = Boolean(summary?.week_report_ready);

      switchEl.hidden = !weekReady;
      if (weekReady && !state.weekModeInitialized) {
        state.effectMode = 'weekly';
        state.weekModeInitialized = true;
      } else if (!weekReady) {
        state.effectMode = 'daily';
        state.weekModeInitialized = false;
      }
      switchEl.querySelectorAll('button').forEach(button => {
        button.classList.toggle('active', button.dataset.effectMode === state.effectMode);
      });

      if (textBubbleInterval) clearInterval(textBubbleInterval);
      if (canvasAnimationId)  cancelAnimationFrame(canvasAnimationId);

      const pick = arr => arr[Math.floor(Math.random() * arr.length)];

      if (state.effectMode === 'weekly' && weekReady) {
        const weekPnl = Number(summary.week_pnl) || 0;
        const weekRate = toNum(summary.week_pnl_pct);
        const weekWinning = weekPnl >= 0;
        titleEl.textContent = weekWinning ? '本周战报：红盘收官' : '本周战报：逆风复盘';
        noteEl.textContent = `${summary.week_start.slice(5)} — ${summary.week_end.slice(5)}`;
        animalEl.classList.add('hidden');
        winningImg.style.display = 'none';
        weeklyEl.hidden = false;
        weeklyEl.className = `weekly-report ${weekWinning ? 'positive' : 'negative'}`;
        document.getElementById('weeklyReportValue').textContent = state.hideValues ? '¥****' : moneyFormatter.format(weekPnl);
        document.getElementById('weeklyReportRate').textContent = `本周收益 ${formatPercent(weekRate)}`;
        bubbleEl.textContent = weekWinning
          ? `本周累计盈利 ${state.hideValues ? '****' : moneyFormatter.format(weekPnl)}，周末好好奖励一下自己。`
          : `本周累计回撤 ${state.hideValues ? '****' : moneyFormatter.format(Math.abs(weekPnl))}，周末复盘，下周再战。`;
        return;
      }

      weeklyEl.hidden = true;

      if (isWinning) {
        titleEl.textContent = '势能：雄霸天下';
        noteEl.textContent  = '今日盈利中';
        animalEl.classList.add('hidden');
        winningImg.style.display = 'block';
        bubbleEl.textContent = pick(dominatePhrases);
        textBubbleInterval = setInterval(() => { bubbleEl.textContent = pick(dominatePhrases); }, 4000);
      } else {
        titleEl.textContent = '势能：治愈贴贴';
        noteEl.textContent  = '回撤抚慰中';
        animalEl.classList.remove('hidden');
        winningImg.style.display = 'none';
        bubbleEl.textContent = pick(cutePhrases);
        textBubbleInterval = setInterval(() => { bubbleEl.textContent = pick(cutePhrases); }, 4000);
      }
    }

    document.getElementById('effectSwitch').addEventListener('click', event => {
      const button = event.target.closest('[data-effect-mode]');
      if (!button) return;
      state.effectMode = button.dataset.effectMode;
      const s = state.summary;
      renderEffect(s ? toNum(s.total_pnl_pct) : 0, s ? s.total_day_pnl : 0, s);
      animateEffectSwitch();
    });


    // ── 仓位结构渲染 ──────────────────────────────────────────
    function renderAllocation() {
      const max = Math.max(...state.holdings.map(x => x.weight), 1);
      document.getElementById('allocationList').innerHTML = [...state.holdings]
        .sort((a, b) => b.weight - a.weight)
        .map(x => `
          <div class="bar-row">
            <div class="bar-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div>
            <div class="track"><div class="fill" style="width:${(x.weight / max * 100).toFixed(2)}%"></div></div>
            <div class="bar-value">${formatPercent(x.weight)}</div>
          </div>`).join('');
    }

    // ── 盈亏分布渲染 ──────────────────────────────────────────
    function renderPnl() {
      const maxAbs = Math.max(...state.holdings.map(x => Math.abs(x.pnl)), 1);
      document.getElementById('pnlList').innerHTML = [...state.holdings]
        .sort((a, b) => a.pnl - b.pnl)
        .map(x => `
          <div class="bar-row">
            <div class="bar-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div>
            <div class="track"><div class="fill ${x.pnl >= 0 ? 'gain' : 'loss'}" style="width:${(Math.abs(x.pnl) / maxAbs * 100).toFixed(2)}%"></div></div>
            <div class="bar-value ${x.pnl >= 0 ? 'positive' : 'negative'}">${moneyFormatter.format(x.pnl)}</div>
          </div>`).join('');
    }

    // ── 历史趋势图渲染 ────────────────────────────────────────
    let historyChartInstance = null;

    // 收益日历只处理 YYYY-MM-DD。统一使用 UTC 日历坐标，
    // 避免浏览器所在时区将东八区零点解析成前一天。
    function ymdToUtcDate(dateText) {
      const [year, month, day] = String(dateText).split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day));
    }

    function utcDateToYmd(date) {
      return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
      ].join('-');
    }

    function addCalendarDays(dateText, days) {
      const date = ymdToUtcDate(dateText);
      date.setUTCDate(date.getUTCDate() + days);
      return utcDateToYmd(date);
    }

    function mondayIndex(dateText) {
      return (ymdToUtcDate(dateText).getUTCDay() + 6) % 7;
    }

    function weekStartKey(dateText) {
      return addCalendarDays(dateText, -mondayIndex(dateText));
    }

    function monthEndKey(monthKey) {
      const [year, month] = monthKey.split('-').map(Number);
      return utcDateToYmd(new Date(Date.UTC(year, month, 0)));
    }

    function historyValueDisplay(value, isAmt) {
      if (isAmt && state.hideValues) return '¥****';
      return isAmt
        ? `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString('zh-CN')}`
        : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
    }

    function historyValueTitle(label, value, isAmt, prefix = '盈亏') {
      if (isAmt && state.hideValues) return `${label} ${prefix} ¥****`;
      const display = historyValueDisplay(value, isAmt);
      return `${label} ${isAmt ? `${prefix} ${display} 元` : `收益率 ${display}`}`;
    }

    function renderIncomeCalendar(history) {
      const calendarDom = document.getElementById('incomeCalendar');
      const summary = document.getElementById('calendarSummary');
      if (!calendarDom || !summary) return;
      if (!history.length) {
        summary.textContent = '暂无收益数据';
        return;
      }

      const isAmt = state.historyPnlMode !== 'pct';
      const rows = [...history].sort((a, b) => a.date.localeCompare(b.date));
      const granularity = state.historyGranularity;

      if (historyChartInstance) {
        historyChartInstance.dispose();
        historyChartInstance = null;
      }

      historyChartInstance = echarts.init(calendarDom);

      if (granularity === 'day') {
        renderDayHeatmap(historyChartInstance, rows, isAmt, summary);
      } else {
        renderPeriodHeatmap(historyChartInstance, rows, isAmt, granularity, summary);
      }
    }

    function renderDayHeatmap(chart, rows, isAmt, summary) {
      const latestDate = rows.at(-1)?.date || '';
      const firstDate = rows[0]?.date || latestDate;
      // 默认滚动 12 个月；若总数据不足 12 个月，则从最早有数据的日期开始，避免大量空白格子。
      const idealStart = latestDate ? addCalendarDays(latestDate, -364) : firstDate;
      const startDate = firstDate > idealStart ? firstDate : idealStart;
      const endDate = latestDate;
      const windowRows = rows.filter(row => row.date >= startDate && row.date <= endDate);

      const data = windowRows.map(row => [
        row.date,
        isAmt ? toNum(row.total_day_pnl) : toNum(row.total_day_pct)
      ]);
      const values = data.map(d => d[1]);
      const maxAbs = Math.max(...values.map(Math.abs), 0.0001);

      summary.textContent = `${startDate.slice(0, 7)} — ${endDate.slice(0, 7)} 收益热力图`;

      chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(10, 15, 30, 0.92)',
          borderColor: 'rgba(51, 65, 85, 0.5)',
          borderWidth: 1,
          textStyle: { color: '#e2e8f0', fontSize: 12 },
          extraCssText: 'backdrop-filter: blur(8px); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);',
          formatter: params => {
            const date = params.data[0];
            const value = params.data[1];
            if (isAmt && state.hideValues) return `${date}<br/>当日盈亏：¥****`;
            const display = historyValueDisplay(value, isAmt);
            return `${date}<br/>${isAmt ? '当日盈亏' : '收益率'}：${display}${isAmt ? ' 元' : ''}`;
          }
        },
        visualMap: {
          show: false,
          min: -maxAbs,
          max: maxAbs,
          calculable: false,
          inRange: { color: ['#10b981', '#0f172a', '#f43f5e'] }
        },
        calendar: {
          top: 18,
          left: 44,
          right: 20,
          bottom: 10,
          cellSize: ['auto', 14],
          range: startDate && endDate ? [startDate, endDate] : latestDate,
          itemStyle: {
            color: 'rgba(15, 23, 42, 0.6)',
            borderColor: 'rgba(51, 65, 85, 0.35)',
            borderWidth: 1,
            borderRadius: 2
          },
          splitLine: { show: false },
          yearLabel: { show: false },
          monthLabel: { color: '#64748b', fontSize: 11, nameMap: 'cn' },
          dayLabel: { color: '#64748b', fontSize: 10, firstDay: 1, nameMap: 'cn' }
        },
        series: {
          type: 'heatmap',
          coordinateSystem: 'calendar',
          data: data,
          itemStyle: { borderRadius: 2 }
        }
      });
    }

    function renderPeriodHeatmap(chart, rows, isAmt, granularity, summary) {
      const grouped = new Map();
      rows.forEach(row => {
        const key = granularity === 'year' ? row.date.slice(0, 4)
          : granularity === 'month' ? row.date.slice(0, 7)
          : weekStartKey(row.date);
        const current = grouped.get(key) || { total_day_pnl: 0, total_day_pct_factor: 1 };
        current.total_day_pnl += toNum(row.total_day_pnl);
        current.total_day_pct_factor *= 1 + toNum(row.total_day_pct) / 100;
        grouped.set(key, current);
      });

      const points = [...grouped.entries()].map(([key, row]) => {
        const value = isAmt ? row.total_day_pnl : (row.total_day_pct_factor - 1) * 100;
        const label = granularity === 'week'
          ? `${key.slice(5)}—${addCalendarDays(key, 4).slice(5)}`
          : granularity === 'month'
            ? `${Number(key.slice(5, 7))}月`
            : key;
        return { key, label, value };
      });

      const values = points.map(p => p.value);
      const maxAbs = Math.max(...values.map(Math.abs), 0.0001);
      const periodText = granularity === 'week' ? '周' : granularity === 'month' ? '月' : '年';
      summary.textContent = `${points[0]?.key || ''} — ${points.at(-1)?.key || ''} · 共${points.length}${periodText}`;

      chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(10, 15, 30, 0.92)',
          borderColor: 'rgba(51, 65, 85, 0.5)',
          borderWidth: 1,
          textStyle: { color: '#e2e8f0', fontSize: 12 },
          extraCssText: 'backdrop-filter: blur(8px); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);',
          formatter: params => {
            const point = points[params.data[0]];
            if (!point) return '';
            if (isAmt && state.hideValues) return `${point.label}<br/>盈亏：¥****`;
            const display = historyValueDisplay(point.value, isAmt);
            return `${point.label}<br/>${isAmt ? '盈亏' : '收益率'}：${display}${isAmt ? ' 元' : ''}`;
          }
        },
        grid: { top: 10, left: 0, right: 20, bottom: 30, containLabel: true },
        xAxis: {
          type: 'category',
          data: points.map((_, i) => i),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: '#64748b',
            fontSize: 11,
            interval: 0,
            formatter: value => points[value]?.label || ''
          }
        },
        yAxis: {
          type: 'category',
          data: ['盈亏'],
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false }
        },
        visualMap: {
          show: false,
          min: -maxAbs,
          max: maxAbs,
          inRange: { color: ['#10b981', '#0f172a', '#f43f5e'] }
        },
        series: {
          type: 'heatmap',
          data: points.map((p, i) => [i, 0, p.value]),
          itemStyle: {
            borderRadius: 4,
            borderColor: 'rgba(51, 65, 85, 0.35)',
            borderWidth: 1
          },
          label: {
            show: points.length <= 24,
            color: '#e2e8f0',
            fontSize: 11,
            formatter: params => {
              if (isAmt && state.hideValues) return '****';
              return historyValueDisplay(params.data[2], isAmt);
            }
          }
        }
      });
    }

    function renderHistoryChart(history) {
      const isAmt = state.historyPnlMode !== 'pct';
      const granularity = state.historyGranularity;
      const sortedHistory = [...history].sort((a, b) => a.date.localeCompare(b.date));
      const latestDate = sortedHistory.at(-1)?.date || '';

      // 日视图日历按滚动窗口展示；柱状图保持原有切片逻辑
      const recentWeekStart = latestDate ? weekStartKey(addCalendarDays(latestDate, -29)) : '';
      const barHistory = granularity === 'day' && latestDate
        ? sortedHistory.filter(row => row.date.slice(0, 7) === latestDate.slice(0, 7))
        : granularity === 'week' && recentWeekStart
          ? sortedHistory.filter(row => row.date >= recentWeekStart && mondayIndex(row.date) <= 4)
          : sortedHistory;
      const calendarHistory = sortedHistory;

      const chartView = document.getElementById('historyChartView');
      const calendarView = document.getElementById('incomeCalendarView');
      if (chartView) chartView.hidden = state.historyViewMode !== 'bar';
      if (calendarView) calendarView.hidden = state.historyViewMode !== 'calendar';

      if (historyChartInstance) {
        historyChartInstance.dispose();
        historyChartInstance = null;
      }

      if (state.historyViewMode === 'calendar') {
        renderIncomeCalendar(calendarHistory);
      } else {
        renderHistoryBarChart(barHistory);
      }
    }

    function renderHistoryBarChart(history) {
      const isAmt = state.historyPnlMode !== 'pct';
      const granularity = state.historyGranularity;

      const grouped = new Map();
      history.forEach(row => {
        const key = granularity === 'year' ? row.date.slice(0, 4)
          : granularity === 'month' ? row.date.slice(0, 7)
          : granularity === 'week' ? weekStartKey(row.date)
          : row.date;
        const current = grouped.get(key) || { total_day_pnl: 0, total_day_pct_factor: 1 };
        current.total_day_pnl += toNum(row.total_day_pnl);
        current.total_day_pct_factor *= 1 + toNum(row.total_day_pct) / 100;
        grouped.set(key, current);
      });

      const points = [...grouped.entries()].map(([key, row]) => {
        const value = isAmt ? row.total_day_pnl : (row.total_day_pct_factor - 1) * 100;
        const label = granularity === 'week'
          ? `${key.slice(5)}—${addCalendarDays(key, 4).slice(5)}`
          : key;
        return { key, label, value };
      });

      const labels = points.map(p => p.label);
      const values = points.map(p => p.value);

      const chartDom = document.getElementById('historyChart');
      if (!chartDom) return;

      historyChartInstance = echarts.init(chartDom);

      historyChartInstance.setOption({
        backgroundColor: 'transparent',
        animationDuration: 700,
        animationEasing: 'cubicOut',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.05)' } },
          backgroundColor: 'rgba(10, 15, 30, 0.92)',
          borderColor: 'rgba(51, 65, 85, 0.5)',
          borderWidth: 1,
          textStyle: { color: '#e2e8f0', fontSize: 12 },
          extraCssText: 'backdrop-filter: blur(8px); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);',
          formatter: params => {
            const p = params[0];
            const val = p.value;
            if (isAmt && state.hideValues) return `${p.name}<br/>盈亏：¥****`;
            const display = historyValueDisplay(val, isAmt);
            return `${p.name}<br/>${isAmt ? '盈亏' : '收益率'}：${display}${isAmt ? ' 元' : ''}`;
          }
        },
        grid: { top: 30, left: 12, right: 12, bottom: 24, containLabel: true },
        xAxis: {
          type: 'category',
          data: labels,
          axisLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.5)' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#64748b',
            fontSize: 11,
            interval: 'auto',
            rotate: labels.length > 12 ? 45 : 0
          }
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: isAmt ? '#00f0ff' : '#10b981',
            fontSize: 11,
            formatter: v => {
              if (isAmt && state.hideValues) return '****';
              return isAmt
                ? (v >= 0 ? '+' : '') + (v / 10000).toFixed(1) + 'w'
                : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
            }
          },
          splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } }
        },
        series: {
          type: 'bar',
          data: values,
          barWidth: '60%',
          itemStyle: {
            borderRadius: params => {
              const v = params.value;
              return v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4];
            },
            color: params => {
              const v = params.value;
              if (v >= 0) {
                return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: '#fb7185' },
                  { offset: 1, color: 'rgba(244, 63, 94, 0.2)' }
                ]);
              }
              return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(16, 185, 129, 0.2)' },
                { offset: 1, color: '#34d399' }
              ]);
            }
          }
        }
      });
    }

    // ── 表格渲染 ──────────────────────────────────────────────
    function currentRows() {
      const kw = state.search.trim().toLowerCase();
      const filtered = state.holdings.filter(x => {
        const matchKw = !kw || `${x.name} ${x.code} ${x.category}`.toLowerCase().includes(kw);
        const matchFilter = state.filter === 'all' || (state.filter === 'gain' ? x.pnl >= 0 : x.pnl < 0);
        return matchKw && matchFilter;
      });
      const sorters = {
        'weight-desc':  (a, b) => b.weight - a.weight,
        'pnl-asc':      (a, b) => a.pnl - b.pnl,
        'pnl-desc':     (a, b) => b.pnl - a.pnl,
        'market-desc':  (a, b) => b.marketValue - a.marketValue,
        'rate-asc':     (a, b) => a.pnlRate - b.pnlRate,
        'rate-desc':    (a, b) => b.pnlRate - a.pnlRate,
      };
      return filtered.sort(sorters[state.sort]);
    }

    function renderTable(isSilent = false) {
      const rows  = currentRows();
      const tbody = document.getElementById('holdingTable');
      const empty = document.getElementById('emptyState');
      empty.hidden = rows.length > 0;
      tbody.innerHTML = rows.map(x => `
        <tr class="${x.code.endsWith('.HK') ? 'portfolio-hk-row' : ''}">
          <td>
            <div class="name-cell">
              <strong>${escapeHtml(x.name)}${x.code.endsWith('.HK') ? '<span class="portfolio-market-badge">港股</span>' : ''}</strong>
              <span class="code">${escapeHtml(x.code)}</span>
            </div>
          </td>
          <td><span class="tag">${escapeHtml(x.category)}</span></td>
          <td>${state.hideValues ? '****' : moneyFormatter.format(x.marketValue)}</td>
          <td>${state.hideValues ? '****' : (x.costPrice === '-' ? '-' : priceFormatter.format(toNum(x.costPrice)))}</td>
          <td>${state.hideValues ? '****' : (x.currentPrice === '-' ? '-' : priceFormatter.format(toNum(x.currentPrice)))}</td>
          <td class="${x.dayPnlRate >= 0 ? 'positive' : 'negative'}">${formatDayPercent(x.dayPnlRate)}</td>
          <td>${state.hideValues ? '****' : numberFormatter.format(x.quantity)}</td>
          <td class="${x.pnl >= 0 ? 'positive' : 'negative'}">${state.hideValues ? '****' : moneyFormatter.format(x.pnl)}</td>
          <td><span class="tag ${x.pnl >= 0 ? 'gain' : 'loss'}">${formatPercent(x.pnlRate)}</span></td>
          <td>${formatPercent(x.weight)}</td>
          <td>${escapeHtml(x.change)}</td>
        </tr>`).join('');

      // 若非静默刷新，执行 GSAP 行错开渐显位移动画
      if (!isSilent && rows.length > 0 && typeof gsap !== 'undefined') {
        gsap.fromTo("#holdingTable tr", 
          { autoAlpha: 0, y: 10 }, 
          { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.02, ease: "power2.out", clearProps: "all" }
        );
      }
    }

    function render(isSilent = false) {
      renderKpis(isSilent);
      renderAllocation();
      renderPnl();
      renderTable(isSilent);
    }

    // ── 事件监听 ──────────────────────────────────────────────
    document.getElementById('searchInput').addEventListener('input', e => {
      state.search = e.target.value;
      renderTable();
    });
    document.getElementById('sortSelect').addEventListener('change', e => {
      state.sort = e.target.value;
      renderTable();
    });
    document.querySelectorAll('.segmented[aria-label="盈亏筛选"] button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.segmented[aria-label="盈亏筛选"] button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.filter = btn.dataset.filter;
        renderTable();
      });
    });

    // 历史粒度切换（日 / 周 / 月 / 年）
    document.querySelectorAll('.history-controls .segmented[aria-label="时间粒度"] button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.history-controls .segmented[aria-label="时间粒度"] button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.historyGranularity = btn.dataset.granularity;
        if (state.historyData) {
          renderHistoryChart(state.historyData);
        } else {
          loadHistory(state.historyDays);
        }
      });
    });

    // 盈亏模式切换 (金额 / 百分比)
    document.querySelectorAll('.history-controls .segmented[aria-label="展示模式"] button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.history-controls .segmented[aria-label="展示模式"] button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.historyPnlMode = btn.dataset.mode;
        if (state.historyData) {
          renderHistoryChart(state.historyData);
        } else {
          loadHistory(state.historyDays);
        }
      });
    });

    // 历史展示方式切换（日历 / 柱状图）
    document.querySelectorAll('.history-controls .segmented[aria-label="视图"] button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.history-controls .segmented[aria-label="视图"] button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.historyViewMode = btn.dataset.view;
        if (state.historyData) renderHistoryChart(state.historyData);
      });
    });

    // 对比时段切换 (当日 / 本月)
    document.querySelectorAll('.compare-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.compare-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.comparePeriod = btn.dataset.period;
        renderComparePanel();
      });
    });

    // 手动刷新按钮
    const refreshBtn = document.getElementById('refreshBtn');
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('loading');
      refreshBtn.textContent = '⟳ 刷新中...';
      try {
        await fetch('/api/holdings/refresh', { method: 'POST' });
        await Promise.all([
          loadLatest(),
          loadHistory(state.historyDays),
          loadIndices()
        ]);
      } finally {
        refreshBtn.classList.remove('loading');
        refreshBtn.textContent = '⟳ 立即刷新';
      }
    });

    // ── 持仓管理 ──────────────────────────────────────────────
    let mgmtHoldingsList = [];  // 所有持仓加载后存入，供汇率提示用
    let cachedFxRateFE   = 0.9148; // 前端缓存汇率

    async function loadMgmt() {
      const resp = await fetch('/api/base-holdings');
      if (!resp.ok) return;
      const data = await resp.json();
      mgmtHoldingsList = data.holdings || [];
      if (data.fx_rate) cachedFxRateFE = data.fx_rate;

      // 填充下拉菜单
      const sel = document.getElementById('mgmtCode');
      const cur = sel.value;
      sel.innerHTML = '<option value="">请选择持仓股票</option>' +
        mgmtHoldingsList.map(h =>
          `<option value="${escapeHtml(h.code)}">${escapeHtml(h.name)}  ${escapeHtml(h.code)}</option>`
        ).join('');
      if (cur) sel.value = cur;

      // 加载全部交易记录
      await loadAllTx();
    }

    async function loadAllTx() {
      const codes = mgmtHoldingsList.map(h => h.code);
      const allTx = [];
      await Promise.all(codes.map(async code => {
        const r = await fetch(`/api/transactions/${encodeURIComponent(code)}`);
        if (!r.ok) return;
        const d = await r.json();
        (d.transactions || []).forEach(t => allTx.push(t));
      }));
      // 按交易日降序排序
      allTx.sort((a, b) => b.trade_date.localeCompare(a.trade_date) || b.id - a.id);
      renderTxList(allTx.slice(0, 20)); // 最近20条
    }

    function renderTxList(list) {
      const tbody = document.getElementById('txTableBody');
      const empty = document.getElementById('txEmpty');
      if (!list.length) { tbody.innerHTML = ''; empty.hidden = false; return; }
      empty.hidden = true;
      const nameMap = Object.fromEntries(mgmtHoldingsList.map(h => [h.code, h.name]));
      tbody.innerHTML = list.map(tx => {
        const cls     = tx.type === 'buy' ? 'tx-buy' : 'tx-sell';
        const label   = tx.type === 'buy' ? '买入' : '卖出';
        const priceStr = tx.price.toFixed(4);
        
        // 查找该股票的今日涨跌
        const holding = state.holdings.find(h => h.code === tx.code);
        let dayPnlStr = '—';
        let dayClass = '';
        if (holding) {
          dayPnlStr = formatDayPercent(holding.dayPnlRate);
          dayClass = holding.dayPnlRate >= 0 ? 'positive' : 'negative';
        }

        return `<tr>
          <td>${escapeHtml(tx.trade_date)}</td>
          <td><span class="${cls}">${escapeHtml(nameMap[tx.code] || tx.code)}</span><br><span style="color:var(--muted);font-size:11px">${escapeHtml(tx.code)}</span></td>
          <td class="${dayClass}">${dayPnlStr}</td>
          <td class="${cls}">${label}</td>
          <td>${tx.quantity}</td>
          <td>${priceStr}</td>
          <td>¥${tx.amount_cny.toFixed(2)}</td>
          <td style="color:var(--muted)">${escapeHtml(tx.note || '—')}</td>
          <td><button class="tx-undo-btn" data-id="${tx.id}" onclick="undoTx(this)">撤销</button></td>
        </tr>`;
      }).join('');
    }

    async function undoTx(btn) {
      const id = btn.dataset.id;
      const bh = mgmtHoldingsList.find(h => {
        // 通过表格行找 code
        const row = btn.closest('tr');
        const codeTd = row.cells[1].innerText.split('\n')[1];
        return h.code === codeTd;
      });
      const label = bh ? bh.name : '该股票';
      if (!confirm(`确认撤销这笔交易？持仓数据将回放重算。`)) return;
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || '撤销失败'); btn.disabled = false; return; }
        await Promise.all([loadMgmt(), loadLatest()]);
      } catch (e) { alert('网络错误'); btn.disabled = false; }
    }

    // 实时换算提示
    function updateMgmtHint() {
      const code = document.getElementById('mgmtCode').value;
      const qty  = parseFloat(document.getElementById('mgmtQty').value);
      const amt  = parseFloat(document.getElementById('mgmtAmt').value);
      const hint = document.getElementById('mgmtHint');
      if (!code || !(qty > 0) || !(amt > 0)) { hint.textContent = ''; return; }
      if (code.endsWith('.HK')) {
        const priceHKD = amt / cachedFxRateFE / qty;
        hint.textContent = `≈ ${priceHKD.toFixed(3)} HKD/股（汇率 ${cachedFxRateFE.toFixed(4)}）`;
      } else {
        const priceCNY = amt / qty;
        hint.textContent = `= ${priceCNY.toFixed(3)} 元/股`;
      }
    }
    ['mgmtCode','mgmtQty','mgmtAmt'].forEach(id =>
      document.getElementById(id).addEventListener('input', updateMgmtHint)
    );

    // 默认日期 = 今天
    document.getElementById('mgmtDate').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

    // 提交交易
    document.getElementById('mgmtSubmit').addEventListener('click', async () => {
      const code = document.getElementById('mgmtCode').value;
      const type = document.getElementById('mgmtType').value;
      const date = document.getElementById('mgmtDate').value;
      const qty  = document.getElementById('mgmtQty').value;
      const amt  = document.getElementById('mgmtAmt').value;
      const note = document.getElementById('mgmtNote').value.trim();
      const errEl = document.getElementById('mgmtErr');
      const btn   = document.getElementById('mgmtSubmit');
      errEl.textContent = '';
      if (!code) { errEl.textContent = '请选择证券'; return; }
      if (!date) { errEl.textContent = '请选择交易日期'; return; }
      if (!(Number(qty) > 0)) { errEl.textContent = '股数必须大于 0'; return; }
      if (!(Number(amt) > 0)) { errEl.textContent = '金额必须大于 0'; return; }
      btn.disabled = true; btn.textContent = '提交中...';
      try {
        const resp = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, type, trade_date: date, quantity: Number(qty), amount_cny: Number(amt), note }),
        });
        const data = await resp.json();
        if (!resp.ok) { errEl.textContent = data.error || '提交失败'; return; }
        // 清空输入
        document.getElementById('mgmtQty').value  = '';
        document.getElementById('mgmtAmt').value  = '';
        document.getElementById('mgmtNote').value = '';
        document.getElementById('mgmtHint').textContent = '';
        // 刷新持仓 + 交易记录
        await Promise.all([loadMgmt(), loadLatest()]);
      } catch (e) {
        errEl.textContent = '网络错误';
      } finally {
        btn.disabled = false; btn.textContent = '✓ 确认记录';
      }
    });

    // ── 自选股 ──────────────────────────────────────────────
    async function loadWatchlist(isSilent = false) {
      const resp = await fetch('/api/watchlist');
      if (!resp.ok) return;
      const data = await resp.json();
      renderWatchlist(data.watchlist || [], isSilent);
    }

    function pctBadgeValueOnly(totalPct) {
      if (!totalPct || totalPct === '-') return '0.00%';
      const v = parseFloat(totalPct);
      const prefix = v >= 0 ? '+' : '';
      return `${prefix}${v.toFixed(2)}%`;
    }

    // 全局自选股列表状态（拖拽用）
    let wlList = [];

    function marketBadge(code) {
      if (code.endsWith('.HK')) return '<span class="wl-market-badge hk">港</span>';
      if (code.endsWith('.SH')) return '<span class="wl-market-badge sh">沪</span>';
      if (code.endsWith('.SZ')) return '<span class="wl-market-badge sz">深</span>';
      return '';
    }

    function renderWatchlist(list, isSilent = false) {
      wlList = list;
      const container = document.getElementById('wlTableBody');
      const empty = document.getElementById('wlEmpty');
      if (!list.length) {
        container.innerHTML = '';
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      container.innerHTML = list.map(item => {
        const isHK     = item.code.endsWith('.HK');
        const priceStr = item.current_price != null ? item.current_price.toFixed(3) : '—';
        const dayClass = item.day_pct ? (parseFloat(item.day_pct) >= 0 ? 'positive' : 'negative') : '';
        const dayStr   = item.day_pct || '—';
        const totalPctVal = toNum(item.total_pct);
        const compareClass = totalPctVal >= 0 ? 'positive' : 'negative';
        
        return `
          <div class="wl-item ${isHK ? 'hk-row' : ''}" draggable="true" data-code="${escapeHtml(item.code)}">
            <div class="wl-item-left">
              <span class="wl-drag-handle" title="拖拽排序">⠿</span>
              <div class="wl-name-box">
                <div class="wl-title-row">
                  <strong class="wl-name">${escapeHtml(item.name)}</strong>
                  ${marketBadge(item.code)}
                </div>
                <span class="wl-code-sub">${escapeHtml(item.code)} ${item.note ? '• ' + escapeHtml(item.note) : ''}</span>
              </div>
            </div>
            <div class="wl-item-right">
              <div class="wl-price-box">
                <div class="wl-current-price">${priceStr}</div>
                <div class="wl-added-compare">比成本 <span class="${compareClass}">${pctBadgeValueOnly(item.total_pct)}</span></div>
              </div>
              <div class="wl-pct-badge-wrapper">
                <span class="wl-pct-badge-pill ${dayClass}">${dayStr}</span>
                <button class="wl-item-delete" data-code="${escapeHtml(item.code)}" onclick="deleteWatchitem(this)" title="删除">×</button>
              </div>
            </div>
          </div>`;
      }).join('');

      // 绑定拖拽事件
      initDragSort(container);

      // 若非静默刷新，执行 GSAP Stagger 入场动效
      if (!isSilent && list.length > 0 && typeof gsap !== 'undefined') {
        gsap.fromTo("#wlTableBody .wl-item", 
          { autoAlpha: 0, x: 15 }, 
          { autoAlpha: 1, x: 0, duration: 0.4, stagger: 0.03, ease: "power2.out", clearProps: "all" }
        );
      }
    }

    async function deleteWatchitem(btn) {
      const code = btn.dataset.code;
      if (!confirm(`确认删除自选股 ${code}？`)) return;
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/watchlist/${encodeURIComponent(code)}`, { method: 'DELETE' });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || '删除失败'); btn.disabled = false; return; }
        await loadWatchlist(false);
      } catch (e) { alert('网络错误'); btn.disabled = false; }
    }

    // ── 拖拽排序 ──────────────────────────────────────────────
    function initDragSort(container) {
      let dragSrc = null;

      container.querySelectorAll('.wl-item').forEach(row => {
        row.addEventListener('dragstart', e => {
          dragSrc = row;
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.dataset.code);
        });

        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          container.querySelectorAll('.wl-item').forEach(r => r.classList.remove('drag-over'));
        });

        row.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          container.querySelectorAll('.wl-item').forEach(r => r.classList.remove('drag-over'));
          if (row !== dragSrc) row.classList.add('drag-over');
        });

        row.addEventListener('drop', async e => {
          e.preventDefault();
          if (!dragSrc || dragSrc === row) return;
          row.classList.remove('drag-over');

          // 重排 DOM
          const rows = [...container.querySelectorAll('.wl-item')];
          const srcIdx  = rows.indexOf(dragSrc);
          const destIdx = rows.indexOf(row);
          if (srcIdx < destIdx) {
            row.after(dragSrc);
          } else {
            row.before(dragSrc);
          }

          // 提取新顺序的 code 列表，持久化到后端
          const newOrder = [...container.querySelectorAll('.wl-item')]
            .map(r => r.dataset.code);
          try {
            await fetch('/api/watchlist/reorder', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ codes: newOrder }),
            });
          } catch (_) { /* 静默失败，下次刷新会恢复 */ }
        });
      });
    }

    document.getElementById('wlAddBtn').addEventListener('click', async () => {
      const raw  = document.getElementById('wlCode').value.trim();
      const nameInput = document.getElementById('wlName').value.trim();
      const note = document.getElementById('wlNote').value.trim();
      const errEl = document.getElementById('wlError');
      const btn   = document.getElementById('wlAddBtn');
      errEl.textContent = '';
      if (!raw) { errEl.textContent = '请输入证券代码或公司名称'; return; }
      
      btn.disabled = true;
      btn.textContent = '智能匹配中...';
      
      let code = normalizeCode(raw.toUpperCase());
      let finalName = nameInput;

      // 若不能解析为常规格式，说明用户输入的是公司名称或拼音，在此通过接口模糊检索
      if (!code) {
        try {
          const resp = await fetch(`/api/stocks/search?q=${encodeURIComponent(raw)}`);
          if (resp.ok) {
            const data = await resp.json();
            if (data.list && data.list.length > 0) {
              code = data.list[0].code;
              finalName = finalName || data.list[0].name;
              document.getElementById('wlCode').value = code;
              document.getElementById('wlName').value = finalName;
            }
          }
        } catch (e) {
          console.error('Submit suggest error:', e);
        }
      }

      if (!code) {
        errEl.textContent = '无法匹配到对应股票：A股请输6位数字或中文名称，港股请输5位数字或中文名称';
        btn.disabled = false;
        btn.textContent = '➕ 确认添加';
        return;
      }

      btn.textContent = '添加中...';
      try {
        const resp = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, name: finalName, note }),
        });
        const data = await resp.json();
        if (!resp.ok) { errEl.textContent = data.error || '添加失败'; btn.disabled = false; btn.textContent = '➕ 确认添加'; return; }
        document.getElementById('wlCode').value = '';
        document.getElementById('wlName').value = '';
        document.getElementById('wlNote').value = '';
        const suggestBox = document.getElementById('wlSuggestBox');
        if (suggestBox) suggestBox.style.display = 'none';
        await loadWatchlist(false);
      } catch (e) {
        errEl.textContent = '网络错误，请稍后重试';
      } finally {
        btn.disabled = false;
        btn.textContent = '➕ 确认添加';
        toggleWlAddPanel(false);
      }
    });

    // ── 自选添加面板滑动切换动画 ──────────────────────────────────
    function toggleWlAddPanel(show) {
      const panel = document.getElementById('wlAddPanel');
      const btn = document.getElementById('wlAddToggleBtn');
      if (!panel || !btn) return;
      if (show) {
        btn.textContent = '－';
        if (typeof gsap !== 'undefined') {
          gsap.set(panel, { display: 'block', height: 0, autoAlpha: 0 });
          gsap.to(panel, {
            height: 'auto',
            autoAlpha: 1,
            duration: 0.35,
            ease: 'power2.out'
          });
        } else {
          panel.style.display = 'block';
        }
      } else {
        btn.textContent = '＋';
        const suggestBox = document.getElementById('wlSuggestBox');
        if (suggestBox) {
          suggestBox.innerHTML = '';
          suggestBox.style.display = 'none';
        }
        if (typeof gsap !== 'undefined') {
          gsap.to(panel, {
            height: 0,
            autoAlpha: 0,
            duration: 0.3,
            ease: 'power2.in',
            onComplete: () => {
              panel.style.display = 'none';
            }
          });
        } else {
          panel.style.display = 'none';
        }
      }
    }

    // ── 自选股代码联想搜索 ─────────────────────────────────────────
    let wlSuggestTimer = null;
    const wlCodeInput = document.getElementById('wlCode');
    const wlSuggestBox = document.getElementById('wlSuggestBox');

    if (wlCodeInput && wlSuggestBox) {
      wlCodeInput.addEventListener('input', () => {
        const val = wlCodeInput.value.trim();
        if (wlSuggestTimer) clearTimeout(wlSuggestTimer);

        if (!val) {
          wlSuggestBox.innerHTML = '';
          wlSuggestBox.style.display = 'none';
          return;
        }

        wlSuggestTimer = setTimeout(async () => {
          try {
            const resp = await fetch(`/api/stocks/search?q=${encodeURIComponent(val)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            const list = data.list || [];

            if (list.length === 0) {
              wlSuggestBox.innerHTML = '';
              wlSuggestBox.style.display = 'none';
              return;
            }

            wlSuggestBox.innerHTML = list.map(item => `
              <div class="wl-suggest-item" data-code="${escapeHtml(item.code)}" data-name="${escapeHtml(item.name)}">
                <strong>${escapeHtml(item.name)}</strong>
                <span class="s-code">${escapeHtml(item.code)}</span>
              </div>
            `).join('');
            wlSuggestBox.style.display = 'block';
          } catch (e) {
            console.error('Suggest fetch error:', e);
          }
        }, 150);
      });

      // 绑定点击列表项选择事件（采用事件委托）
      wlSuggestBox.addEventListener('click', e => {
        const item = e.target.closest('.wl-suggest-item');
        if (!item) return;
        
        const code = item.dataset.code;
        const name = item.dataset.name;

        wlCodeInput.value = code;
        document.getElementById('wlName').value = name;
        
        wlSuggestBox.innerHTML = '';
        wlSuggestBox.style.display = 'none';
        
        // 自动聚焦下一个输入框（Note 输入框）
        const noteEl = document.getElementById('wlNote');
        if (noteEl) noteEl.focus();
      });

      // 点击页面其他位置自动隐藏联想提示框
      document.addEventListener('click', e => {
        if (!e.target.closest('#wlCode') && !e.target.closest('#wlSuggestBox')) {
          wlSuggestBox.style.display = 'none';
        }
      });
    }

    /**
     * 智能补全证券代码格式
     * 000858       → 000858.SZ（0/2/3 开头）
     * 600036       → 600036.SH（6/688 开头）
     * 09626        → 09626.HK（5位纯数字，港股）
     * 已含后缀则原样返回
     */
    function normalizeCode(raw) {
      if (!raw) return '';
      // 已包含后缀，直接返回
      if (/\.(SH|SZ|HK)$/i.test(raw)) return raw.toUpperCase();
      // 纯数字判断
      if (/^\d+$/.test(raw)) {
        if (raw.length === 6) {
          const prefix = raw[0];
          if ('69'.includes(prefix)) return raw + '.SH';      // 沪市：6xxxx / 科创：688xxx
          if ('0123'.includes(prefix)) return raw + '.SZ';   // 深市：0xxxx / 创业板：3xxxx
          return '';  // 无法判断
        }
        if (raw.length === 5) return raw + '.HK';            // 港股 5 位
        return '';
      }
      return '';
    }

    // Enter 快捷提交
    ['wlCode', 'wlName', 'wlNote'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('wlAddBtn').click();
      });
    });

    // ── 标签页 (Tab) 切换控制 ─────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        
        // 激活按钮样式
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // 激活内容展示
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const activeTab = document.getElementById(`tab-${tabName}`);
        activeTab.classList.add('active');

        // 执行 GSAP Tab 内容入场动画
        if (typeof gsap !== 'undefined') {
          const children = activeTab.children;
          if (children.length > 0) {
            gsap.fromTo(children,
              { autoAlpha: 0, y: 15 },
              { autoAlpha: 1, y: 0, duration: 0.45, stagger: 0.05, ease: "power2.out", clearProps: "all" }
            );
          }
        }
        
        // 如果切回 overview 重新 resize 图表以防 canvas 宽度变为 0
        if (tabName === 'overview' && historyChartInstance) {
          setTimeout(() => {
            historyChartInstance.resize();
          }, 50);
        }
        // 如果切到交易记录页，加载/刷新数据
        if (tabName === 'transactions') {
          loadMgmt();
        }
      });
    });

    // ── 自选股添加表单展开/收折控制 ───────────────────────────
    document.getElementById('wlAddToggleBtn').addEventListener('click', () => {
      const panel = document.getElementById('wlAddPanel');
      const isHidden = panel.style.display === 'none' || panel.style.height === '0px';
      toggleWlAddPanel(isHidden);
    });

    // ── 动态自选股组件位置挂载逻辑 ─────────────────────────────
    function adjustWatchlistPosition() {
      const comp = document.getElementById('watchlistComponent');
      const sidebar = document.getElementById('sidebarArea');
      const mobileContainer = document.getElementById('tab-watchlist');
      if (!comp || !sidebar || !mobileContainer) return;
      
      const isMobile = window.innerWidth <= 900;
      if (isMobile) {
        if (comp.parentElement !== mobileContainer) {
          mobileContainer.appendChild(comp);
        }
      } else {
        if (comp.parentElement !== sidebar) {
          sidebar.appendChild(comp);
        }
      }
    }
    window.addEventListener('resize', adjustWatchlistPosition);
    window.addEventListener('resize', () => {
      if (historyChartInstance) historyChartInstance.resize();
    });

    // ── 隐私数值显示与隐藏控制 ────────────────────────────────────
    document.getElementById('privacyBtn').addEventListener('click', () => {
      state.hideValues = !state.hideValues;
      const btn = document.getElementById('privacyBtn');
      if (state.hideValues) {
        btn.innerHTML = '🙈 显示数值';
        btn.title = '显示敏感数值';
      } else {
        btn.innerHTML = '👁 隐藏数值';
        btn.title = '隐藏敏感数值';
      }
      // 重绘页面，采用静默刷新避免数字动画闪烁
      render(true);
      renderWatchlist(wlList, true);
      if (state.historyData) renderHistoryChart(state.historyData);
    });

    // ── 启动 ──────────────────────────────────────────────────
    async function boot() {
      adjustWatchlistPosition();
      try {
        await Promise.all([
          loadLatest(false),
          loadHistory(state.historyDays),
          loadWatchlist(false),
          loadMgmt(),
          loadIndices(),
        ]);
      } catch (err) {
        document.getElementById('sourceState').textContent = `加载失败: ${err.message}`;
        document.getElementById('subtitle').textContent = '无法连接到数据服务，请确认 Node 服务已启动';
      }
    }

    boot();

    // 每 60 秒自动重新拉取（非阻塞，静默刷新）
    setInterval(async () => {
      try {
        await Promise.all([
          loadLatest(true),
          loadHistory(state.historyDays),
          loadWatchlist(true),
          loadIndices(),
        ]);
      } catch (_) {}
    }, 60 * 1000);
