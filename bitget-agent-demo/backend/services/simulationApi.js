/**
 * 昨日 demo-bot 模拟盘 API 封装
 * 直接复用 demo-bot/bitget-v3.js（UTA V3 · paptrading:1）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAssets,
  getTicker,
  placeSpotOrder,
  getUnfilledOrders,
  findAsset,
  getCurrentPositions,
} from "../../../demo-bot/bitget-v3.js";
import { getCandles as getBitgetCandles } from "./bitgetClient.js";
import { isSimApiConfigured, getSimAuthStatus } from "./simCredentials.js";
import { checkRisk } from "../../../demo-bot/risk.js";
import demoConfig from "../../../demo-bot/config.json" with { type: "json" };
import { gatherPerception } from "./perceptionSkills.js";
import { applyPerceptionGate } from "./perceptionGate.js";
import { enrichDecisionQty, checkStrategyRisk } from "./strategyExecution.js";
import { normalizeFuturesPositions, enrichFuturesMarkPrices } from "./futuresUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, "../../../demo-bot/logs/trades.jsonl");

export { isSimApiConfigured } from "./simCredentials.js";

export function normalizeCandles(raw) {
  if (!raw?.length) return [];
  return raw.map((row) =>
    Array.isArray(row)
      ? {
          time: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
        }
      : row
  );
}

/** 按策略类型计算 K 线周期、条数、品类（避免 demoConfig.candleLimit=30 导致指标不够） */
export function resolveCandleParams(strategy = null) {
  const type = strategy?.type;
  const granularity =
    strategy?.candleGranularity ||
    (type === "breakout_trend" ? "1H" : null) ||
    demoConfig.candleGranularity ||
    "1h";

  let limit = Number(strategy?.candleLimit) || Number(demoConfig.candleLimit) || 120;

  if (type === "breakout_trend") {
    const trendMa = strategy?.conditions?.trendMaPeriod || 200;
    limit = Math.max(limit, trendMa + 50);
  } else if (type === "sar_macd") {
    limit = Math.max(limit, 120);
  } else if (type === "trend" && strategy?.conditions?.maPeriod) {
    limit = Math.max(limit, strategy.conditions.maPeriod + 20);
  } else {
    limit = Math.max(limit, 60);
  }

  const category =
    strategy?.category === "futures" ||
    strategy?.category === "USDT-FUTURES" ||
    /永续|合约|futures/i.test(String(strategy?.category || ""))
      ? "USDT-FUTURES"
      : "USDT-FUTURES";

  return { granularity, limit, category };
}

export async function getSimCandles(symbol, granularity = "1h", limit = 120) {
  return normalizeCandles(await getBitgetCandles(symbol, granularity, limit));
}

function categoryForStrategy(strategy, useFuturesVenue = false) {
  const c = String(strategy?.category || "").toLowerCase();
  if (c === "spot") return "SPOT";
  if (useFuturesVenue || c.includes("futures") || !c) return "USDT-FUTURES";
  return "USDT-FUTURES";
}

function resolveLogCategory(log) {
  if (/FUTURES|futures/i.test(String(log?.category || ""))) return "futures";
  if (String(log?.tradeType || "").startsWith("futures")) return "futures";
  if (String(log?.source || "").includes("trading-agent")) return "futures";
  if (String(log?.source || "").includes("strategy")) return "futures";
  return "spot";
}

/** 交易日志只展示真实委托：成交 / 失败 / 挂单 / 撤销，不含「观望跳过」 */
function isTradeLogEntry(entry) {
  return ["filled", "failed", "pending", "cancelled"].includes(entry?.status);
}

function appendLog(entry) {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

export function appendSimTradeLog(entry) {
  appendLog(entry);
}

export async function getSimStatus() {
  const auth = getSimAuthStatus();
  const { getKnownDemoSymbols } = await import("./demoSymbolGuard.js");
  const { getBitgetExecutionStatus } = await import("./bitgetExecution.js");
  return {
    configured: auth.configured,
    paperTrading: true,
    api: "bitget-api",
    apiBase: "https://api.bitget.com",
    version: "UTA-V3",
    execution: getBitgetExecutionStatus(),
    config: demoConfig,
    logFile: LOG_FILE,
    auth,
    demoTradableSymbols: getKnownDemoSymbols(),
    demoTradableNote: "执行层统一调用 Bitget 模拟盘 API · 扫描/行情支持全 USDT 现货",
  };
}

function coinQty(a) {
  const available = Number(a.available || 0);
  const balance = Number(a.balance || 0);
  const equity = Number(a.equity || 0);
  if (available > 0) return a.available;
  if (balance > 0) return a.balance;
  if (equity > 0 && a.coin !== "USDT") return a.equity;
  return a.available ?? a.balance ?? "0";
}

function normalizeSpotAssets(raw) {
  const list = raw?.assets || [];
  return list
    .filter(
      (a) =>
        Number(a.available || a.balance || a.equity || 0) > 0 ||
        Number(a.frozen || a.locked || 0) > 0 ||
        Number(a.usdValue ?? 0) > 0.01
    )
    .map((a) => ({
      coin: a.coin,
      available: coinQty(a),
      frozen: a.frozen ?? a.locked ?? "0",
      usdValue: Number(a.usdValue ?? 0),
    }))
    .sort((a, b) => b.usdValue - a.usdValue);
}


export async function getSimAccount() {
  if (!isSimApiConfigured()) {
    return { configured: false, message: "请配置 demo-bot/.env 或 backend/.env" };
  }

  const assets = await getAssets();
  const spotAssets = normalizeSpotAssets(assets);
  const usdt = findAsset(assets, "USDT");
  const btc = findAsset(assets, "BTC");

  let futuresPositions = [];
  try {
    futuresPositions = await getCurrentPositions("USDT-FUTURES");
  } catch { /* 无合约权限或暂无持仓 */ }
  let normalizedFutures = normalizeFuturesPositions(futuresPositions);
  normalizedFutures = await enrichFuturesMarkPrices(normalizedFutures);

  return {
    configured: true,
    paperTrading: true,
    accountEquity: Number(assets.accountEquity || 0),
    unrealisedPnl: Number(assets.unrealisedPnl || assets.usdtUnrealisedPnl || 0),
    usdt: { available: usdt?.available ?? "0", frozen: usdt?.frozen ?? usdt?.locked ?? "0" },
    btc: { available: btc?.available ?? "0", frozen: btc?.frozen ?? btc?.locked ?? "0" },
    spotAssets,
    futuresPositions: normalizedFutures,
    raw: assets,
  };
}

/** 从真实模拟账户构建回测初始状态（按 usdValue 计价，与账户权益一致） */
export function buildBacktestBasis(account, symbol = "BTCUSDT", markPrice = 0) {
  if (!account?.configured) return null;

  const baseCoin = symbol.replace(/USDT$/i, "");
  const assets = account.raw?.assets || [];
  const price = Number(markPrice) || 0;

  let usdtAvailable = Number(account.usdt?.available || 0);
  let usdtEquityUsd = 0;
  let position = 0;
  let otherAssetsUsd = 0;

  for (const a of assets) {
    const usd = Number(a.usdValue ?? a.equity ?? 0);
    if (a.coin === "USDT") {
      usdtAvailable = Number(a.available ?? usdtAvailable);
      usdtEquityUsd = usd || Number(a.balance ?? usdtAvailable);
    } else if (a.coin === baseCoin) {
      position = Number(a.available || 0);
    } else {
      otherAssetsUsd += usd;
    }
  }

  if (baseCoin === "BTC" && position === 0) {
    position = Number(account.btc?.available || 0);
  }

  const positionUsd = position * price;
  const accountEquity = Number(account.raw?.accountEquity || 0);
  const sumParts = usdtEquityUsd + positionUsd + otherAssetsUsd;
  const initialEquity = accountEquity > 0 ? accountEquity : sumParts;

  // 回测现金 = USDT 权益部分（不是 available，避免 19997 vs 19972 矛盾）
  const cash = usdtEquityUsd > 0 ? usdtEquityUsd : Math.min(usdtAvailable, initialEquity - positionUsd - otherAssetsUsd);

  return {
    cash: Math.max(0, cash),
    position,
    entryPrice: position > 0 ? price : 0,
    otherAssetsUsd,
    initialEquity,
    baseCoin,
    accountEquity: initialEquity,
    usdtAvailable,
    usdtEquityUsd,
    realAccountEquity: accountEquity || initialEquity,
  };
}

export async function getSimOpenOrders(symbol = demoConfig.symbol) {
  if (!isSimApiConfigured()) return [];
  const { normalizeSymbol } = await import("./symbolUtils.js");
  const sym = normalizeSymbol(symbol);
  try {
    const raw = await getUnfilledOrders(sym);
    return raw.map((o) => normalizeOpenOrder(o, sym));
  } catch (e) {
    if (/40034|does not exist|不存在/i.test(e.message)) return [];
    throw e;
  }
}

const DEFAULT_ORDER_SCAN_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "PEPEUSDT",
  "WLDUSDT",
  "AAVEUSDT",
];

/** 统一 Bitget / Hub 挂单字段，便于前端展示 */
export function normalizeOpenOrder(o, fallbackSymbol) {
  if (!o) return null;
  const sym = String(o.symbol || fallbackSymbol || "").toUpperCase();
  const side = String(o.side || o.tradeSide || "").toLowerCase();
  const orderType = String(o.orderType || o.order_type || "").toLowerCase();
  const filledQty = pickPositiveNumber(o.fillSize, o.cumExecQty, o.baseVolume);
  let qty = pickPositiveNumber(
    o.qty,
    o.size,
    o.baseSize,
    o.quantity,
    o.orderQty,
    o.leavesQty,
    o.leavesSize,
    o.origQty,
    o.origSize,
    filledQty
  );
  let qtyIsQuote = false;
  if (!qty && orderType === "market" && side === "buy") {
    qty = pickPositiveNumber(o.amount, o.quoteVolume, o.quoteSize);
    qtyIsQuote = qty > 0;
  }
  let price = pickPositiveNumber(
    o.price,
    o.ordPrice,
    o.delegatePrice,
    o.limitPrice,
    o.orderPrice,
    o.priceAvg
  );
  const quoteAmount = pickPositiveNumber(o.quoteVolume, o.quoteSize, o.amount);
  if (!price && qty > 0 && quoteAmount > 0 && !qtyIsQuote) {
    price = quoteAmount / qty;
  }
  return {
    ...o,
    orderId: o.orderId || o.order_id || o.id || null,
    symbol: sym,
    side,
    qty: qty || 0,
    qtyIsQuote,
    price: price || 0,
    quoteAmount: quoteAmount || 0,
    orderType: orderType || (price > 0 ? "limit" : "market"),
    status: o.status || o.orderStatus || o.state || "live",
    category: o.category || "spot",
  };
}

export async function cancelSimOrder({ symbol, orderId }) {
  if (!isSimApiConfigured()) throw new Error("模拟 API 未连接");
  if (!orderId) throw new Error("缺少 orderId");
  const { normalizeSymbol } = await import("./symbolUtils.js");
  const { cancelSpotOrder } = await import("../../../demo-bot/bitget-v3.js");
  const sym = normalizeSymbol(symbol);
  return cancelSpotOrder({ symbol: sym, orderId: String(orderId) });
}

function symbolsFromRecentTradeLogs(maxLines = 80) {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
    const syms = new Set();
    for (const line of lines.slice(-maxLines)) {
      try {
        const row = JSON.parse(line);
        if (row.symbol) syms.add(String(row.symbol).toUpperCase());
      } catch {
        /* ignore */
      }
    }
    return [...syms];
  } catch {
    return [];
  }
}

/** 拉取多交易对未成交挂单 — 持仓 + 近期交易 + 常用对 */
export async function getSimAllOpenOrders(extraSymbols = []) {
  if (!isSimApiConfigured()) return [];
  const { normalizeSymbol, symbolsFromHoldings } = await import("./symbolUtils.js");

  let accountSymbols = [];
  try {
    const acct = await getSimAccount();
    accountSymbols = symbolsFromHoldings(acct?.spotAssets || []);
  } catch {
    /* ignore */
  }

  const symbols = new Set([
    ...accountSymbols,
    ...extraSymbols.map((s) => normalizeSymbol(s, "")).filter(Boolean),
    ...DEFAULT_ORDER_SCAN_SYMBOLS,
    ...symbolsFromRecentTradeLogs(),
  ]);

  const merged = [];
  const seen = new Set();
  for (const sym of symbols) {
    if (!sym) continue;
    try {
      const orders = await getUnfilledOrders(sym);
      for (const o of orders) {
        const normalized = normalizeOpenOrder(o, sym);
        const id = normalized.orderId || normalized.clientOid;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        merged.push(normalized);
      }
    } catch (e) {
      if (!/40034|does not exist|不存在/i.test(e.message)) {
        console.warn("[getSimAllOpenOrders]", sym, e.message);
      }
    }
  }
  return merged;
}

export async function cancelAllAccountOrders() {
  if (!isSimApiConfigured()) return [];
  const { cancelAllSpotOrders } = await import("../../../demo-bot/bitget-v3.js");
  const acct = await getSimAccount();
  const symbols = [
    ...new Set([
      ...(acct?.spotAssets || [])
        .filter((a) => a.coin !== "USDT")
        .map((a) => `${a.coin}USDT`),
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
    ]),
  ];
  const results = [];
  for (const sym of symbols) {
    try {
      const r = await cancelAllSpotOrders(sym);
      if (r.length) results.push({ symbol: sym, cancelled: r.length, results: r });
    } catch {
      /* ignore */
    }
  }
  return results;
}

export async function placeSimOrder({ symbol, side, qty, orderType = "market", price, skipLog = false }) {
  const { executeBitgetSpotOrder } = await import("./bitgetExecution.js");
  const { assertDemoTradable } = await import("./demoSymbolGuard.js");
  const sym = await assertDemoTradable(symbol || demoConfig.symbol);

  const order = await executeBitgetSpotOrder({
    symbol: sym,
    side,
    qty: Number(qty),
    orderType,
    price,
    qtyUnit: "base",
  });
  if (!skipLog) {
    appendLog({
      ts: new Date().toISOString(),
      source: "chat-agent",
      symbol: sym,
      side,
      qty,
      orderType,
      order,
      executed: true,
      decision: {
        action: side,
        reason: `${side === "buy" ? "买入" : "卖出"} ${sym.replace(/USDT$/i, "")} · ${orderType} · qty ${qty}${order?.orderId ? ` · #${order.orderId}` : ""}`,
      },
    });
  }
  try {
    const assets = await getAssets();
    let futuresPositions = [];
    try {
      futuresPositions = await getCurrentPositions("USDT-FUTURES");
    } catch {
      /* ignore */
    }
    const { recordEquitySnapshot } = await import("./accountAnalysis.js");
    recordEquitySnapshot(assets, "all", futuresPositions);
  } catch {
    /* ignore */
  }
  return order;
}

/** 执行策略决策 — 统一 Bitget API（bitget-core → bitget-v3） */
export async function executeSimDecision(decision, symbol = demoConfig.symbol, options = {}) {
  const { executeBitgetDecision } = await import("./bitgetExecution.js");
  const sym = symbol || demoConfig.symbol;
  const strategy = options.strategy || { symbol: sym };
  const order = await executeBitgetDecision(decision, strategy, {
    symbol: sym,
    strict: options.strict !== false,
    allowFallback: true,
  });
  if (!order) return null;

  const useFut = order.category === "USDT-FUTURES";
  return {
    ...order,
    tradeLabel:
      order.tradeLabel ||
      (decision.action === "buy"
        ? useFut
          ? "合约开多"
          : "现货买入"
        : useFut
          ? "合约平多"
          : "现货卖出"),
  };
}

/**
 * 一轮模拟交易 tick — 与 demo-bot/bot.js runOnce 同源逻辑
 * 可传入 Hackathon 策略参数覆盖 demoConfig
 */
export async function runSimTick(strategy = null, options = {}) {
  const mode = options.mode || (options.strict ? "strict" : "legacy");
  const useStrictExec = mode === "agent" || mode === "strict";
  const ts = new Date().toISOString();
  const symbol = strategy?.symbol || demoConfig.symbol;
  const { granularity, limit: candleLimit, category } = resolveCandleParams(strategy);

  let candlesRaw = [];
  try {
    candlesRaw = await getBitgetCandles(symbol, granularity, candleLimit, category);
  } catch (e) {
    console.warn(`[runSimTick] K线获取失败 ${symbol} ${granularity}×${candleLimit}:`, e.message);
  }

  const { fetchPositionContext, isFuturesStrategy, buildTradeRecord } = await import(
    "./agentTradeExecution.js"
  );
  const { fetchBitgetSpotPrice, fetchBitgetFuturesPrice } = await import("./bitgetLivePrice.js");
  const useFuturesVenueEarly = isFuturesStrategy(strategy);
  const [assets, live] = await Promise.all([
    getAssets(),
    useFuturesVenueEarly
      ? fetchBitgetFuturesPrice(symbol)
      : fetchBitgetSpotPrice(symbol),
  ]);

  const baseCoin = symbol.replace(/USDT$/i, "");
  const baseAsset = findAsset(assets, baseCoin);
  const usdt = findAsset(assets, "USDT");
  const baseAvailable = baseAsset?.available ?? "0";
  const usdtAvailable = usdt?.available ?? "0";
  const lastPrice = live.lastPrice;

  const posCtx = await fetchPositionContext(symbol, strategy);
  const useFuturesVenue = isFuturesStrategy(strategy) || posCtx.hasLong || posCtx.hasShort;
  const sessionEntry = Number(options.session?.entryPrice || 0);
  const { resolveLivePositionState } = await import("./strategyExecution.js");
  const livePos = resolveLivePositionState({
    symbol,
    strategy,
    posCtx,
    baseAvailable,
    lastPrice,
    sessionEntryPrice: sessionEntry,
  });
  const hasBase = livePos.hasWalletAsset;
  const hasStrategyPosition = livePos.hasStrategyPosition;
  const positionAvailable = useFuturesVenue
    ? posCtx.longSize || posCtx.shortSize || 0
    : Number(baseAvailable);
  const effectiveEntryPrice = sessionEntry > 0 ? sessionEntry : 0;

  let strategySignal;
  if (strategy?.type === "sar_macd") {
    const candles = normalizeCandles(candlesRaw);
    const { decideSarMacdTick } = await import("./sarMacdStrategy.js");
    const result = decideSarMacdTick({
      candles,
      lastPrice,
      hasBase,
      baseAvailable: positionAvailable,
      usdtAvailable,
      strategy,
      sessionEntryPrice: effectiveEntryPrice,
    });
    strategySignal = {
      action: result.action,
      reason: result.reason,
      qty: result.qty,
      sellPct: result.sellPct,
      posSide: result.posSide,
      evaluation: result.evaluation,
    };
  } else if (strategy?.type === "breakout_trend") {
    const candles = normalizeCandles(candlesRaw);
    const { decideBreakoutTrendTick } = await import("./breakoutTrendStrategy.js");
    const result = decideBreakoutTrendTick({
      candles,
      lastPrice,
      hasBase,
      baseAvailable: positionAvailable,
      usdtAvailable,
      strategy,
      sessionEntryPrice: effectiveEntryPrice,
    });
    strategySignal = {
      action: result.action,
      reason: result.reason,
      qty: result.qty,
      sellPct: result.sellPct,
      posSide: result.posSide,
      evaluation: result.evaluation,
    };
  } else if (strategy?.type === "ema_pullback") {
    const candles = normalizeCandles(candlesRaw);
    const { decideEmaPullbackTick } = await import("./emaPullbackStrategy.js");
    const result = decideEmaPullbackTick({
      candles,
      lastPrice,
      hasBase,
      baseAvailable: positionAvailable,
      usdtAvailable,
      strategy,
      sessionEntryPrice: effectiveEntryPrice,
    });
    strategySignal = {
      action: result.action,
      reason: result.reason,
      qty: result.qty,
      sellPct: result.sellPct,
      posSide: result.posSide,
      evaluation: result.evaluation,
    };
  } else if (strategy?.type === "trend" && strategy.conditions) {
    const candles = normalizeCandles(candlesRaw);
    const closes = candles.map((c) => c.close);
    const maPeriod = strategy.conditions.maPeriod || 20;
    if (closes.length < maPeriod) {
      strategySignal = { action: "hold", reason: "K线数据不足" };
    } else {
      const ma = closes.slice(-maPeriod).reduce((a, b) => a + b, 0) / maPeriod;
      const volMult = strategy.conditions.volumeMultiplier || 1.5;
      const latest = candles.at(-1);
      const volAvg = candles.slice(-maPeriod).reduce((s, c) => s + c.volume, 0) / maPeriod;
      const volRatio = latest.volume / volAvg;

      if (lastPrice > ma && volRatio >= volMult && !hasStrategyPosition) {
        strategySignal = {
          action: "buy",
          reason: `突破MA${maPeriod} 量比${volRatio.toFixed(2)}x`,
        };
      } else if (lastPrice < ma * 0.995 && hasStrategyPosition) {
        strategySignal = { action: "sell", reason: `跌破MA${maPeriod} 止损` };
      } else {
        strategySignal = {
          action: "hold",
          reason: `趋势观望 · 价${lastPrice.toFixed(2)} MA${maPeriod}=${ma.toFixed(2)} 量比${volRatio.toFixed(2)}`,
        };
      }
    }
  } else if (strategy?.type === "grid") {
    const candles = normalizeCandles(candlesRaw);
    const latest = candles.at(-1);
    const prev = candles.at(-2);
    const spacing = (strategy.conditions?.gridSpacingPct || 1.2) / 100;
    if (latest && prev) {
      const change = (latest.close - prev.close) / prev.close;
      if (change <= -spacing && !hasStrategyPosition) {
        strategySignal = { action: "buy", reason: `${baseCoin} 网格下轨 ${(change * 100).toFixed(2)}%` };
      } else if (change >= spacing && hasStrategyPosition) {
        strategySignal = { action: "sell", reason: `${baseCoin} 网格上轨 ${(change * 100).toFixed(2)}%` };
      } else {
        strategySignal = { action: "hold", reason: `${baseCoin} 网格观望 ${(change * 100).toFixed(2)}%` };
      }
    } else {
      strategySignal = { action: "hold", reason: "K线数据不足" };
    }
  } else {
    const { ruleStrategy } = await import("../../../demo-bot/strategy.js");
    strategySignal = ruleStrategy({ candles: candlesRaw, btcAvailable: baseAvailable, lastPrice });
  }

  let decision = { ...strategySignal };
  let perception = null;
  let perceptionSummary = null;
  let fused = null;
  let exitEval = null;
  let agentRisk = null;

  const accountState = {
    usdtAvailable,
    baseAvailable,
    lastPrice,
    hasBase,
  };
  const sessionState = options.session || {};

  if (mode === "agent") {
    const {
      agentPerceive,
      fuseAgentDecision,
      evaluateAgentExit,
      evaluateAgentRisk,
      applyExitToDecision,
    } = await import("./tradingAgent.js");

    perception = options.cachedPerception || (await agentPerceive(symbol));
    fused = await fuseAgentDecision(strategySignal, perception, strategy, {
      strategyHasPosition: livePos.hasStrategyPosition,
      walletHasAsset: livePos.hasWalletAsset,
    });
    decision = { ...fused.decision };

    exitEval = await evaluateAgentExit({
      hasBase: livePos.hasStrategyPosition,
      entryPrice: effectiveEntryPrice,
      lastPrice,
      strategy,
      strategySignal,
      perception,
    });

    const exitOverlay = applyExitToDecision(decision, exitEval, fused);
    decision = exitOverlay.decision;
    fused = exitOverlay.fused;
  } else {
    const usePerception = strategy?.usePerception !== false;
    if (usePerception && strategySignal.action !== "hold") {
      try {
        perception = await gatherPerception(symbol);
        const gated = applyPerceptionGate(strategySignal, perception, { usePerception: true });
        decision = { ...gated.decision };
        perceptionSummary = gated.perceptionSummary;
      } catch (e) {
        console.warn("[runSimTick] 感知 Skill 不可用:", e.message);
      }
    } else if (useStrictExec && strategySignal.action !== "hold") {
      decision = { ...strategySignal, reason: `[严格] ${strategySignal.reason}` };
    }
  }

  decision = enrichDecisionQty(decision, strategy, {
    usdtAvailable,
    baseAvailable: positionAvailable,
    lastPrice,
    posCtx,
  });

  if (mode === "agent" && fused) {
    perceptionSummary = fused.perceptionSummary;
    const { evaluateAgentRisk } = await import("./tradingAgent.js");
    agentRisk = await evaluateAgentRisk({
      decision,
      strategy,
      accountState,
      sessionState,
      perception,
      config: {
        ...demoConfig,
      },
    });
  } else if (useStrictExec && mode !== "agent" && decision.action !== "hold") {
    decision = {
      ...decision,
      reason: `[严格] ${decision.reason}`,
    };
  }

  const risk =
    mode === "agent" && agentRisk
      ? agentRisk
      : useStrictExec
        ? checkStrategyRisk({
            decision,
            config: demoConfig,
            usdtAvailable,
            baseAvailable,
            lastPrice,
          })
        : checkRisk({
            decision,
            config: {
              ...demoConfig,
              orderSizeBtc: strategy?.orderSizeBtc || demoConfig.orderSizeBtc,
            },
            usdtAvailable,
            btcAvailable: baseAvailable,
          });

  async function attachAgent(payload) {
    if (mode === "agent" && fused) {
      const { buildAgentTrace } = await import("./tradingAgent.js");
      payload.agent = buildAgentTrace({
        perception,
        strategySignal,
        fused,
        risk,
        exit: exitEval,
        executed: payload.executed ?? false,
        order: payload.order || null,
        orderError: payload.orderError || null,
      });
      payload.riskPause = risk?.pause || false;
    }
    payload.mode = mode;
    if (!payload.category) {
      payload.category = categoryForStrategy(strategy, useFuturesVenue);
    }
    return payload;
  }

  if (!risk.ok) {
    const blocked = decision.action !== "hold";
    const blockedDecision = blocked
      ? {
          action: "hold",
          reason: `风控拦截 · 原计划${decision.action === "sell" ? "卖出" : "买入"} · ${risk.reason}`,
          blockedAction: decision.action,
          evaluation: decision.evaluation,
        }
      : decision;
    const entry = await attachAgent({
      ts,
      symbol,
      strategyType: strategy?.type,
      decision: blockedDecision,
      risk,
      perception: perceptionSummary,
      executed: false,
      orderError: blocked ? risk.reason : null,
    });
    if (blocked) appendLog(entry);
    return { ...entry, perceptionSnapshot: perception, account: { usdtAvailable, baseAvailable, baseCoin, lastPrice } };
  }

  if (decision.action === "hold") {
    const entry = await attachAgent({
      ts,
      symbol,
      strategyType: strategy?.type,
      decision,
      perception: perceptionSummary,
      executed: false,
    });
    return { ...entry, perceptionSnapshot: perception, account: { usdtAvailable, baseAvailable, baseCoin, lastPrice } };
  }

  let order = null;
  let orderError = null;
  try {
    if (useStrictExec) {
      const openOrders = await getUnfilledOrders(symbol);
      if (openOrders.length > 0) {
        const { cancelAllSpotOrders } = await import("../../../demo-bot/bitget-v3.js");
        await cancelAllSpotOrders(symbol);
      }
    } else {
      const openOrders = await getUnfilledOrders(symbol);
      if (openOrders.length > 0) {
        const entry = {
          ts,
          symbol,
          category: categoryForStrategy(strategy, useFuturesVenue),
          decision: { action: "hold", reason: `有 ${openOrders.length} 笔未成交挂单，跳过` },
          openOrders,
          executed: false,
        };
        return { ...entry, perceptionSnapshot: perception, account: { usdtAvailable, baseAvailable, baseCoin, lastPrice } };
      }
    }

    order = await executeSimDecision(decision, symbol, { strict: useStrictExec, strategy });
    if (!order?.orderId) {
      orderError =
        decision.action === "sell"
          ? "交易所未成交（现货可用不足、低于最小下单量，或持仓在合约账户）"
          : "交易所未返回 orderId，可能未成交";
    }
  } catch (e) {
    orderError = e.message;
  }

  const executed = !!order?.orderId;
  if (!executed && decision.action !== "hold" && !orderError) {
    orderError = "决策未执行（无有效持仓或未提交交易所）";
  }
  const entry = await attachAgent({
    ts,
    symbol,
    strategyType: strategy?.type,
    strategyRunId: strategy?.runId || strategy?.id,
    decision,
    order: order || null,
    orderError,
    perception: perceptionSummary,
    executed,
    source: mode === "agent" ? "trading-agent" : useStrictExec ? "strategy-strict" : "strategy-tick",
    tradeType: executed ? order?.tradeType : null,
    tradeLabel: executed ? order?.tradeLabel : null,
    category: order?.category || (useFuturesVenue ? "USDT-FUTURES" : "SPOT"),
    posSide: order?.posSide || null,
    qty: executed ? order?.qty || decision.qty : decision.qty,
    price: executed ? order?.price || lastPrice : lastPrice,
  });

  const tradeRecord = buildTradeRecord({
    ts,
    source: entry.source,
    strategyRunId: strategy?.runId || strategy?.id,
    strategyType: strategy?.type,
    strategyName: strategy?.name,
    tradeType:
      order?.tradeType ||
      (executed
        ? decision.action === "buy"
          ? useFuturesVenue
            ? "futures_open_long"
            : "spot_buy"
          : useFuturesVenue
            ? "futures_close_long"
            : "spot_sell"
        : null),
    category: entry.category,
    symbol,
    side: order?.side || decision.action,
    posSide: order?.posSide || null,
    qty: order?.qty || decision.qty,
    price: order?.price || lastPrice,
    orderType: useStrictExec ? "market" : "limit",
    order,
    executed,
    orderError,
    decision,
    agent: entry.agent,
  });

  appendLog({ ...entry, ...tradeRecord, agent: entry.agent });

  return { ...entry, perceptionSnapshot: perception, account: { usdtAvailable, baseAvailable, baseCoin, lastPrice } };
}

function logScore(log) {
  let score = 0;
  if (log.decision?.reason) score += 10;
  if (log.symbol) score += 5;
  if (log.category) score += 3;
  if (log.posSide) score += 2;
  if (log.source === "chat-agent") score += 1;
  return score;
}

function dedupeSimLogs(logs) {
  const byOrderId = new Map();
  const standalone = [];

  for (const log of logs) {
    const orderId = log.order?.orderId;
    if (!orderId) {
      standalone.push(log);
      continue;
    }
    const existing = byOrderId.get(orderId);
    if (!existing || logScore(log) > logScore(existing)) {
      byOrderId.set(orderId, log);
    }
  }

  return [...byOrderId.values(), ...standalone];
}

function historyOrderToLogEntry(o) {
  const isFutures = o.category === "futures";
  const coin = (o.symbol || "").replace(/USDT$/i, "");
  const posSide = o.posSide || null;
  let side = o.side;
  if (isFutures && posSide) side = posSide;

  const priceStr = o.price ? `$${Number(o.price).toFixed(2)}` : "";
  const reason = isFutures
    ? `${posSide === "long" ? "合约开多" : posSide === "short" ? "合约开空" : "合约"} ${coin} · ${o.qty}${priceStr ? ` @ ${priceStr}` : ""}`
    : `${o.side === "buy" ? "买入" : "卖出"} ${coin} · ${o.qty}${priceStr ? ` @ ${priceStr}` : ""}`;

  return {
    ts: new Date(o.time || Date.now()).toISOString(),
    source: "bitget-history",
    category: isFutures ? "USDT-FUTURES" : "SPOT",
    symbol: o.symbol,
    side,
    posSide,
    qty: o.qty,
    price: o.price,
    orderType: o.orderType,
    executed: true,
    order: { orderId: o.orderId },
    decision: { action: side, reason },
  };
}

function formatTradeQty(order) {
  const qty = Number(order?.qty || 0);
  if (!qty) return "0";
  if (order?.qtyIsQuote) return `${qty.toFixed(2)} USDT`;
  if (qty >= 1000) return qty.toFixed(2);
  if (qty >= 1) return qty.toFixed(4);
  return qty.toFixed(6);
}

function formatTradePrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function tradeActionFromOrder(o) {
  if (o?.tradeLabel) return o.tradeLabel;
  if (o?.tradeType === "futures_open_long") return "开多";
  if (o?.tradeType === "futures_open_short") return "开空";
  if (o?.tradeType === "futures_close_long") return "平多";
  if (o?.tradeType === "futures_close_short") return "平空";
  if (o?.category === "futures") {
    const ps = o.posSide || o.side;
    if (ps === "long") return o.side === "sell" ? "平多" : "开多";
    if (ps === "short") return o.side === "buy" ? "平空" : "开空";
    return "合约";
  }
  if (o?.side === "buy") return "买入";
  if (o?.side === "sell") return "卖出";
  return String(o?.side || "—").toUpperCase();
}

function tradeActionFromLog(log) {
  if (log?.tradeLabel) return log.tradeLabel;
  if (log?.tradeType === "futures_open_long") return "开多";
  if (log?.tradeType === "futures_open_short") return "开空";
  if (log?.tradeType === "futures_close_long") return "平多";
  if (log?.tradeType === "futures_close_short") return "平空";
  const side = String(log?.side || log?.decision?.action || "").toLowerCase();
  if (/futures/i.test(String(log?.category || ""))) {
    if (side === "long") return "开多";
    if (side === "short") return "开空";
  }
  if (side === "buy") return "买入";
  if (side === "sell") return "卖出";
  return side || "—";
}

function tradeStatusFromLog(log) {
  if (log?.executed) return "filled";
  if (log?.error || log?.orderError) return "failed";
  return "skipped";
}

function tradeStatusFromOrder(o) {
  const s = String(o?.status || "").toLowerCase();
  if (/filled|full|success|done|complete/.test(s)) return "filled";
  if (/fail|reject|error/.test(s)) return "failed";
  if (/cancel/.test(s)) return "cancelled";
  if (/live|new|init|partial|open/.test(s)) return "pending";
  return o?.executed === false ? "failed" : "filled";
}

function orderToTradeEntry(o) {
  const action = tradeActionFromOrder(o);
  const price = Number(o.price) || 0;
  return {
    id: o.orderId || o.id,
    orderId: o.orderId || null,
    clientOid: o.clientOid || null,
    time: o.time || Date.now(),
    ts: new Date(o.time || Date.now()).toISOString(),
    symbol: o.symbol,
    category: o.category === "futures" ? "futures" : "spot",
    action,
    side: o.side || null,
    posSide: o.posSide || null,
    orderType: o.orderType || "market",
    qty: o.qty || 0,
    qtyDisplay: formatTradeQty(o),
    price,
    priceDisplay: formatTradePrice(price),
    quoteValue: o.quoteValue || null,
    status: tradeStatusFromOrder(o),
    executed: tradeStatusFromOrder(o) === "filled",
    source: o.source || "bitget",
    reason: `${action} ${o.symbol}${price ? ` @ ${formatTradePrice(price)}` : ""}`,
    error: null,
  };
}

function logToTradeEntry(log) {
  const order = log?.order || {};
  const orderId = order.orderId || order.clientOid || null;
  const isFutures = resolveLogCategory(log) === "futures";
  const category = isFutures ? "futures" : "spot";
  const action = tradeActionFromLog(log);
  const price = Number(log.price || order.avgPrice || order.price || 0);
  const qty = Number(log.qty || order.cumExecQty || order.qty || 0);
  const status = tradeStatusFromLog(log);
  const ts = log.ts || new Date().toISOString();

  return {
    id: orderId || `log-${log.symbol}-${ts}`,
    orderId,
    clientOid: order.clientOid || null,
    time: new Date(ts).getTime(),
    ts,
    symbol: log.symbol || order.symbol,
    category,
    action,
    side: log.side || log.decision?.action || null,
    posSide: log.posSide || null,
    orderType: log.orderType || order.orderType || "market",
    qty,
    qtyDisplay: qty ? (log.usdtAmount && !isFutures && log.side === "buy" ? `${Number(log.usdtAmount).toFixed(2)} USDT` : formatTradeQty({ qty })) : "—",
    price,
    priceDisplay: formatTradePrice(price),
    quoteValue: log.usdtAmount ? Number(log.usdtAmount) : null,
    status,
    executed: status === "filled",
    source: log.source || (log.executed ? "agent" : "local"),
    reason: log.decision?.reason || `${action} ${log.symbol || ""}`.trim(),
    error: log.error || log.orderError || null,
  };
}

function mergeTradeEntries(historyOrders, rawLogs, cap) {
  const byKey = new Map();

  for (const o of historyOrders) {
    const entry = orderToTradeEntry(o);
    byKey.set(entry.orderId || entry.id, entry);
  }

  for (const log of rawLogs) {
    const entry = logToTradeEntry(log);
    const key = entry.orderId || entry.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    if (existing.source === "bitget" && entry.error) {
      existing.error = entry.error;
      existing.reason = entry.reason || existing.reason;
    }
    if (existing.status !== "filled" && entry.status === "filled") {
      byKey.set(key, { ...existing, ...entry, source: existing.source });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .slice(0, cap);
}

export async function getSimLogs(limit = 20) {
  const cap = Math.min(Math.max(1, limit), 100);
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
    logs = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .reverse();
  }

  logs = dedupeSimLogs(logs);

  try {
    const history = await getSimHistoryOrders([], cap);
    const seen = new Set(logs.map((l) => l.order?.orderId).filter(Boolean));
    for (const o of history) {
      if (o.orderId && !seen.has(o.orderId)) {
        logs.push(historyOrderToLogEntry(o));
        seen.add(o.orderId);
      }
    }
  } catch {
    /* ignore history merge */
  }

  return logs
    .sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0))
    .slice(0, cap);
}

/** 模拟交易日志 — 本地记录 + Bitget 历史订单合并，每笔可查 orderId */
export async function getSimTradeLogs(limit = 50) {
  const cap = Math.min(Math.max(1, limit), 100);
  const rawLogs = await getSimLogs(cap);

  let historyOrders = [];
  try {
    if (isSimApiConfigured()) {
      historyOrders = await getSimHistoryOrders([], cap);
    }
  } catch {
    /* ignore */
  }

  const entries = mergeTradeEntries(historyOrders, rawLogs, cap).filter(isTradeLogEntry);
  const filled = entries.filter((e) => e.status === "filled").length;
  const failed = entries.filter((e) => e.status === "failed").length;

  return {
    logs: rawLogs,
    entries,
    meta: {
      updatedAt: new Date().toISOString(),
      total: entries.length,
      filled,
      failed,
      source: isSimApiConfigured() ? "bitget-api" : "local",
    },
  };
}

function pickPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function logEntryToHistoryOrder(log) {
  if (!log?.executed) return null;

  const order = log.order || {};
  const symbol = log.symbol || order.symbol;
  if (!symbol) return null;
  const ts = log.ts ? new Date(log.ts).getTime() : Date.now();
  const orderId = order.orderId || order.clientOid || null;

  const isFutures = /FUTURES/i.test(String(log.category || ""));
  const category = isFutures ? "futures" : "spot";

  let posSide = log.posSide ? String(log.posSide).toLowerCase() : null;
  let side = String(log.side || log.decision?.action || "").toLowerCase();

  if (isFutures) {
    if (side === "long" || side === "short") posSide = posSide || side;
    if (posSide === "long") side = "buy";
    else if (posSide === "short") side = "sell";
  }

  let qty = pickPositiveNumber(order.cumExecQty, order.baseVolume, log.qty);
  let qtyIsQuote = false;
  if (!qty && category === "spot" && side === "buy") {
    qty = pickPositiveNumber(log.qty, order.cumExecValue);
    qtyIsQuote = qty > 0;
  }
  if (!qty) qty = Number(log.qty) || 0;

  let price = pickPositiveNumber(order.avgPrice, order.priceAvg, log.price);
  if (!price && qty > 0 && !qtyIsQuote && log.usdtAmount) {
    price = Number(log.usdtAmount) / qty;
  }

  return {
    id: orderId || `log-${log.symbol}-${ts}`,
    orderId,
    symbol: log.symbol,
    side,
    orderType: log.orderType || "market",
    qty,
    qtyIsQuote,
    price,
    time: ts,
    status: "filled",
    source: log.executed ? "agent-log" : "local-log",
    category,
    posSide,
    tradeType: log.tradeType || null,
    tradeLabel: log.tradeLabel || null,
    executed: !!log.executed,
  };
}

function historyOrdersFromLogs(limit = 20) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-Math.max(limit, 30))
    .map((line) => {
      try {
        return logEntryToHistoryOrder(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeHistoryOrder(o, sym, category = "spot") {
  const ts = Number(o.updatedTime || o.createdTime || o.uTime || o.cTime || 0);
  const side = String(o.side || "").toLowerCase();
  const orderType = String(o.orderType || "").toLowerCase();
  const filledQty = pickPositiveNumber(o.cumExecQty, o.baseVolume);
  const avgPrice = pickPositiveNumber(o.avgPrice, o.priceAvg, o.fillPrice);
  const quoteFilled = pickPositiveNumber(o.cumExecValue, o.quoteVolume);

  let qty = filledQty;
  let qtyIsQuote = false;
  if (!qty) {
    if (orderType === "market" && side === "buy") {
      qty = pickPositiveNumber(o.amount, o.quoteVolume, o.size);
      qtyIsQuote = qty > 0;
    } else {
      qty = pickPositiveNumber(o.qty, o.size, o.baseVolume);
    }
  }

  let price = avgPrice;
  if (!price && filledQty > 0 && quoteFilled > 0) {
    price = quoteFilled / filledQty;
  }
  if (!price) {
    price = pickPositiveNumber(o.price);
  }

  const posSide = String(o.posSide || "").toLowerCase() || null;

  return {
    id: o.orderId || o.clientOid || `${sym}-${ts}`,
    orderId: o.orderId,
    symbol: o.symbol || sym,
    side,
    orderType,
    qty,
    qtyIsQuote,
    price,
    quoteValue: quoteFilled || (qtyIsQuote ? qty : 0),
    time: ts || Date.now(),
    status: o.orderStatus || o.status || o.state,
    source: "bitget",
    category,
    posSide,
  };
}

/** 最近成交订单（含现货 + 合约、聊天与策略 tick） */
export async function getSimHistoryOrders(extraSymbols = [], limit = 20) {
  if (!isSimApiConfigured()) return [];
  const { getHistoryOrders, getFuturesHistoryOrders } = await import("../../../demo-bot/bitget-v3.js");
  const { normalizeSymbol, symbolsFromHoldings } = await import("./symbolUtils.js");
  const { getKnownDemoSymbols } = await import("./demoSymbolGuard.js");

  let accountSymbols = [];
  let futuresSymbols = [];
  try {
    const acct = await getSimAccount();
    accountSymbols = symbolsFromHoldings(acct?.spotAssets || []);
    futuresSymbols = (acct?.futuresPositions || [])
      .map((p) => normalizeSymbol(p.symbol || "", ""))
      .filter(Boolean);
  } catch {
    /* ignore */
  }

  const spotSymbols = [
    ...new Set([
      ...getKnownDemoSymbols(),
      ...accountSymbols,
      ...extraSymbols.map((s) => normalizeSymbol(s, "")).filter(Boolean),
    ]),
  ];

  const futSymbols = [
    ...new Set([
      ...futuresSymbols,
      ...extraSymbols.map((s) => normalizeSymbol(s, "")).filter(Boolean),
      "BTCUSDT",
      "ETHUSDT",
    ]),
  ];

  const merged = [];
  const perSpot = Math.min(100, Math.max(5, Math.ceil(limit / Math.max(spotSymbols.length, 1))));
  const perFut = Math.min(100, Math.max(5, Math.ceil(limit / Math.max(futSymbols.length, 1))));

  for (const sym of spotSymbols) {
    try {
      const rows = await getHistoryOrders(sym, perSpot);
      for (const o of rows) {
        merged.push(normalizeHistoryOrder(o, sym, "spot"));
      }
    } catch (e) {
      if (!/40034|does not exist|不存在/i.test(e.message)) {
        console.warn("[getSimHistoryOrders]", sym, e.message);
      }
    }
  }

  for (const sym of futSymbols) {
    try {
      const rows = await getFuturesHistoryOrders(sym, perFut);
      for (const o of rows) {
        merged.push(normalizeHistoryOrder(o, sym, "futures"));
      }
    } catch (e) {
      if (!/40034|does not exist|不存在/i.test(e.message)) {
        console.warn("[getSimHistoryOrders:futures]", sym, e.message);
      }
    }
  }

  const seen = new Set(merged.map((o) => o.orderId || o.id));
  for (const o of historyOrdersFromLogs(limit)) {
    const key = o.orderId || o.id;
    if (!seen.has(key)) {
      merged.push(o);
      seen.add(key);
    }
  }

  return merged.sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, limit);
}
