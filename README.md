# HoldingsLens 🔍

**HoldingsLens** 是一个高颜值、极客风的资产持仓可视化分析面板与个人投资助理系统。项目采用赛博朋克暗黑科技风设计，专为追求视觉美感与数据深度的投资者打造。

[English](#english) | [简体中文](#简体中文)

---

## 简体中文

### 🌟 核心特性

1. **赛博科技风 UI 设计 (Cyberpunk Dark Aesthetic)**
   * 采用深色背景（`#060814`）搭配双色霓虹渐变（青色与靛蓝色）的发光气场。
   * 卡片采用磨砂玻璃拟态设计（Glassmorphism），支持平滑的鼠标悬浮微调及微光边框特效。
   * 搭载苹果原生 **San Francisco (SF Pro)** 极客数字字体，带来利落、高级的数字阅读体验。

2. **双重状态 AI 情绪助理 (Sentient AI Companion)**
   * 面板顶部集成智能助理，根据组合的总盈亏自动激活对应的交互状态：
     * **治愈贴贴模式（亏损时）**：CSS 渲染的萌系小猫咪，会眨眼、动耳朵、挥爪撒娇，并生成治愈温情的鼓励话语，安抚波动情绪。
     * **雄霸天下模式（盈利时）**：Canvas 渲染的金色与青色霓虹粒子流和引力波冲击特效，配合霸气、硬核的文字轮播，带来绝对的胜利质感。

3. **穿透式资产结构分析 (ETF Look-Through)**
   * 支持多只 ETF（如中概互联、恒指科技、港股通互联网）底层持仓的深度穿透，一键洞察腾讯、阿里、美团等重仓股的实际真实暴露仓位与比重。
   * 包含仓位结构分布与盈亏分布图表，直观呈现资产集中度与回撤分布。

4. **明细管理与操作记录**
   * 支持通过本地 `holdings.csv` 文件一键管理持仓，包含成本价、现价、累计盈亏及占比。
   * 特设“操作记录”列，方便随时追踪仓位的增减调整百分比。

### 📂 项目结构

* `持仓明细展示.html` - 核心可视化展示网页，本地双击即可运行。
* `holdings.csv` - 数据源文件，包含所有持仓的明细与合计数据。
* `update_holdings.py` - 持仓数据同步/更新脚本（Python 辅助脚本）。
* `.gitignore` - 已自动配置，用于忽略 macOS 缓存文件 `.DS_Store` 及测试日志文件。

---

## English

### 🌟 Core Features

1. **Cyberpunk Dark Aesthetic UI**
   * Deep navy-black background (`#060814`) decorated with subtle cyber grid pattern and dual neon cyan/indigo ambient radial glows.
   * Glassmorphism panel cards featuring smooth hover transitions and neon border glows.
   * Integrated Apple native **San Francisco (SF Pro)** typography stack for crisp and clean numerical display.

2. **Sentient AI Companion**
   * An interactive virtual assistant card built at the top row, dynamically responding to overall portfolio P&L:
     * **Healing Mascot (Drawdowns)**: A cute CSS animated kitten that winks, twitches ears, waves paws, and rotates comforting quotes to soothe emotion during market dips.
     * **Overlord Warp Effect (Profits)**: A high-performance Canvas particle storm with expanding circular neon shockwaves and epic dominating lines celebrating your gains.

3. **ETF Look-Through Analysis**
   * Easily calculates underlying holdings (e.g. Tencent, Alibaba, Meituan) across multiple tech ETFs (Hang Seng TECH, CNH Internet) to reveal true asset exposure.
   * Visualizes asset allocation structure and risk-weighted profit/loss distribution.

4. **Operation Tracker & Logging**
   * Easily driven by `holdings.csv` containing market value, cost, price, and calculated weights.
   * Specifically logs adjustments using the "Operation Record" column (percentage of added/reduced positions).

### 📂 Project Structure

* `持仓明细展示.html` - The main visualization dashboard. Double-click to open in any browser.
* `holdings.csv` - Data source file containing raw holdings and totals.
* `update_holdings.py` - Python script for helper automated data syncing.
* `.gitignore` - Standard gitignore configuration for OS/log caches.
