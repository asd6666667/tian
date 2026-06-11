import "./setupProxy.js";

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import express from "express";
import cors from "cors";
import { parseIntentAsync, getPresetStrategies, cloneStrategyForSymbol } from "./services/intentParser.js";
import { handleChatMessage, buildAssistantMessage, runAutonomousRoundStream } from "./services/chatAgent.js";
import { runBacktest } from "./services/backtest.js";
import { getMarketSnapshot } from "./services/marketData.js";
import {
  hubGetMarketMetrics,
  hubGetSentiment,
  hubHealthCheck,
  hubGetPerception,
  hubGetAccount,
} from "./services/bitgetHub.js";
import {
  getOrCreateSession,
  tickPaperSession,
  tickAllPaperStrategies,
  addPaperStrategy,
  removePaperStrategy,
  executePaperOrder,
  initBitgetSession,
} from "./services/paperTrading.js";
import {
  getSimStatus,
  getSimAccount,
  getSimOpenOrders,
  getSimAllOpenOrders,
  placeSimOrder,
  runSimTick,
  getSimTradeLogs,
  getSimHistoryOrders,
  isSimApiConfigured,
  buildBacktestBasis,
} from "./services/simulationApi.js";
import { connectSimApi, disconnectSimApi, getSimAuthStatus, resetSimLogoutFlag } from "./services/simCredentials.js";
import { resetAgentHubCache, syncHubCredentials } from "./services/agentHubBridge.js";
import { getAccountPnLAnalysis } from "./services/accountAnalysis.js";
import {
  getAgentHubCapabilities,
  listAgentHubTools,
  callAgentHubTool,
} from "./services/agentHubBridge.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const chatSessions = new Map();

resetSimLogoutFlag();
syncHubCredentials();

// ── Bitget Agent Hub + 感知 Skill API ──
app.get("/api/hub/health", async (_req, res) => {
  try {
    const health = await hubHealthCheck();
    health.agentHubCore = getAgentHubCapabilities();
    res.json(health);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/hub/market/:symbol?", async (req, res) => {
  try {
    const symbol = req.params.symbol || "BTCUSDT";
    res.json(await hubGetMarketMetrics(symbol));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/hub/sentiment", async (_req, res) => {
  try {
    res.json(await hubGetSentiment());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/hub/perception/:symbol?", async (req, res) => {
  try {
    const force = req.query.force === "1";
    res.json(await hubGetPerception(req.params.symbol || "BTCUSDT", { force }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/bitget/account", async (_req, res) => {
  try {
    res.json(await hubGetAccount());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/hub/capabilities", (_req, res) => {
  try {
    res.json(getAgentHubCapabilities());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/hub/tools", (req, res) => {
  try {
    const { module, readOnly } = req.query;
    res.json({
      ...getAgentHubCapabilities(),
      tools: listAgentHubTools({
        module: module || undefined,
        readOnly: readOnly === "1" ? true : readOnly === "0" ? false : undefined,
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/hub/tools/:toolName", async (req, res) => {
  try {
    res.json(await callAgentHubTool(req.params.toolName, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── 昨日 demo-bot 模拟 API（UTA V3） ──
app.get("/api/sim/status", async (_req, res) => {
  try {
    res.json(await getSimStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/bitget/execution", async (_req, res) => {
  try {
    const { getBitgetExecutionStatus } = await import("./services/bitgetExecution.js");
    res.json(getBitgetExecutionStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sim/connect", async (req, res) => {
  try {
    const auth = await connectSimApi(req.body);
    res.json({ ok: true, auth });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sim/disconnect", async (_req, res) => {
  try {
    const auth = disconnectSimApi();
    res.json({ ok: true, auth });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sim/auth", async (_req, res) => {
  try {
    res.json(getSimAuthStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sim/account", async (_req, res) => {
  try {
    res.json(await getSimAccount());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sim/orders/:symbol?", async (req, res) => {
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    if (all) {
      const { normalizeSymbol } = await import("./services/symbolUtils.js");
      const extra = req.query.symbols
        ? String(req.query.symbols).split(",").map((s) => normalizeSymbol(s.trim()))
        : [];
      const orders = await getSimAllOpenOrders(extra);
      return res.json({ orders, all: true });
    }
    const { normalizeSymbol } = await import("./services/symbolUtils.js");
    const symbol = normalizeSymbol(req.params.symbol || "BTCUSDT");
    const orders = await getSimOpenOrders(symbol);
    res.json({ orders, symbol });
  } catch (e) {
    res.json({ orders: [], symbol: req.params.symbol, warning: e.message });
  }
});

app.get("/api/sim/pnl-analysis", async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const symbol = req.query.symbol || "BTCUSDT";
    res.json(await getAccountPnLAnalysis({ days, symbol }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sim/logs", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    res.json(await getSimTradeLogs(limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sim/history-orders", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const symbols = req.query.symbols
      ? String(req.query.symbols).split(",").map((s) => s.trim())
      : [];
    const orders = await getSimHistoryOrders(symbols, limit);
    res.json({ orders });
  } catch (e) {
    res.json({ orders: [], warning: e.message });
  }
});

app.post("/api/sim/tick", async (req, res) => {
  try {
    if (!isSimApiConfigured()) {
      return res.status(400).json({ error: "模拟 API 未配置，请设置 demo-bot/.env" });
    }
    const mode = req.body.mode || "agent";
    const result = await runSimTick(req.body.strategy, { mode });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sim/order", async (req, res) => {
  try {
    const { symbol, side, qty, orderType, price } = req.body;
    const order = await placeSimOrder({ symbol, side, qty, orderType, price });
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sim/cancel", async (req, res) => {
  try {
    if (!isSimApiConfigured()) return res.status(400).json({ error: "模拟 API 未配置" });
    const { symbol, orderId, all } = req.body;
    if (all) {
      const { cancelAllAccountOrders } = await import("./services/simulationApi.js");
      const results = await cancelAllAccountOrders();
      return res.json({ ok: true, results });
    }
    if (!orderId) return res.status(400).json({ error: "缺少 orderId" });
    const { cancelSimOrder } = await import("./services/simulationApi.js");
    const result = await cancelSimOrder({ symbol, orderId });
    res.json({ ok: true, result, orderId, symbol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 自主一轮策略（SSE 实时链路） ──
app.post("/api/chat/autonomous-round/stream", async (req, res) => {
  const { message, previousStrategy, sessionId } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: "请输入消息" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  const sid = sessionId || `chat_${Date.now()}`;
  const history = chatSessions.get(sid) || [];
  const prev = previousStrategy || [...history].reverse().find((m) => m.strategy)?.strategy || null;

  history.push({ role: "user", content: message.trim(), time: Date.now() });

  const send = (payload) => {
    if (clientGone || res.writableEnded) return false;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (typeof res.flush === "function") res.flush();
      return true;
    } catch {
      clientGone = true;
      return false;
    }
  };

  try {
    const result = await runAutonomousRoundStream(message.trim(), prev, send);
    const assistantMsg = buildAssistantMessage(result, { slim: true });
    history.push(assistantMsg);
    chatSessions.set(sid, history);
    send({
      phase: "done",
      sessionId: sid,
      content: result.content,
      kind: result.kind,
      strategy: assistantMsg.strategy,
      strategyCheck: assistantMsg.strategyCheck,
      agent: assistantMsg.agent,
      tick: assistantMsg.tick,
      market: result.market,
      autonomousThought: result.autonomousThought,
      generatedBy: result.generatedBy,
      autoStartPaper: result.autoStartPaper,
    });
  } catch (e) {
    send({ phase: "error", error: e.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ── 对话机器人（Bitget + 感知 Skill） ──
app.post("/api/chat/message", async (req, res) => {
  try {
    const { message, sessionId, previousStrategy, forcePerception } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "请输入消息" });

    const sid = sessionId || `chat_${Date.now()}`;
    const history = chatSessions.get(sid) || [];
    const prev = previousStrategy || [...history].reverse().find((m) => m.strategy)?.strategy || null;

    history.push({ role: "user", content: message.trim(), time: Date.now() });

    const result = await handleChatMessage({
      message: message.trim(),
      previousStrategy: prev,
      forcePerception: !!forcePerception,
    });
    const assistantMsg = buildAssistantMessage(result);
    history.push(assistantMsg);
    chatSessions.set(sid, history);

    res.json({
      sessionId: sid,
      history,
      strategy: result.strategy || prev,
      action: result,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 自然语言策略解析（兼容旧接口，走 chatAgent） ──
app.post("/api/strategy/parse", async (req, res) => {
  const { message, sessionId, previousStrategy } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "请输入策略描述" });

  const sid = sessionId || `chat_${Date.now()}`;
  const history = chatSessions.get(sid) || [];
  const prev = previousStrategy || history.at(-1)?.strategy || null;

  history.push({ role: "user", content: message, time: Date.now() });

  const result = await handleChatMessage({ message, previousStrategy: prev });
  const assistantMsg = buildAssistantMessage(result);
  history.push(assistantMsg);
  chatSessions.set(sid, history);

  res.json({
    sessionId: sid,
    strategy: result.strategy || prev,
    reply: result.content,
    history,
    action: result,
  });
});

// ── 自主策略生成（感知 + AI 思考） ──
app.post("/api/strategy/autonomous", async (req, res) => {
  const { symbol, hint, sessionId, previousStrategy } = req.body;
  const sym = String(symbol || "BTCUSDT").toUpperCase();

  try {
    const { generateAutonomousStrategy } = await import("./services/agentHubStrategy.js");
    const generated = await generateAutonomousStrategy({
      symbol: sym,
      hint: hint || "",
      previousStrategy: previousStrategy || null,
    });

    const sid = sessionId || `chat_${Date.now()}`;
    const history = chatSessions.get(sid) || [];
    const assistantMsg = buildAssistantMessage({
      kind: "strategy",
      content: `已自主分析 ${sym.replace("USDT", "")} 市场并生成策略`,
      ...generated,
      generatedBy: "autonomous",
    });
    history.push(assistantMsg);
    chatSessions.set(sid, history);

    res.json({
      sessionId: sid,
      ...generated,
      history,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/strategy/presets", (_req, res) => {
  res.json(getPresetStrategies());
});

app.post("/api/strategy/apply-symbol", async (req, res) => {
  try {
    const { strategy, symbol } = req.body;
    if (!strategy?.symbol) return res.status(400).json({ error: "缺少策略" });
    if (!symbol) return res.status(400).json({ error: "缺少 symbol" });
    const { resolveSymbolFromText } = await import("./services/symbolUtils.js");
    const sym = await resolveSymbolFromText(String(symbol), strategy.symbol);
    res.json(cloneStrategyForSymbol(strategy, sym));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 回测 + 策略对比 ──
app.post("/api/backtest/run", async (req, res) => {
  try {
    const { strategy, compareWith, granularity } = req.body;
    if (!strategy) return res.status(400).json({ error: "缺少策略参数" });

    const marketOpts = {
      granularity: granularity || "1H",
      maPeriod: strategy.conditions?.maPeriod || 20,
    };
    const market = await getMarketSnapshot(strategy.symbol || "BTCUSDT", marketOpts);

    let accountBasis = null;
    let accountSource = "virtual_default";
    let initialCapital = 10000;

    if (isSimApiConfigured()) {
      try {
        const acct = await getSimAccount();
        const mark = market.candles[0]?.close || market.price;
        accountBasis = buildBacktestBasis(acct, strategy.symbol || "BTCUSDT", mark);
        if (accountBasis) {
          accountSource = "real_paper_account";
          initialCapital = accountBasis.initialEquity;
        }
      } catch (e) {
        console.warn("回测读取真实账户失败:", e.message);
      }
    }

    const result = runBacktest(strategy, market.candles, accountBasis || initialCapital);

    let comparison = null;
    if (compareWith) {
      const prev = runBacktest(compareWith, market.candles, accountBasis || initialCapital);
      comparison = {
        previous: prev.metrics,
        current: result.metrics,
        delta: {
          totalReturnPct: +(result.metrics.totalReturnPct - prev.metrics.totalReturnPct).toFixed(2),
          winRate: +(result.metrics.winRate - prev.metrics.winRate).toFixed(1),
          maxDrawdownPct: +(result.metrics.maxDrawdownPct - prev.metrics.maxDrawdownPct).toFixed(2),
          sharpeRatio: +(result.metrics.sharpeRatio - prev.metrics.sharpeRatio).toFixed(2),
        },
      };
    }

    res.json({
      strategy,
      accountSource,
      initialCapital,
      accountBasis,
      market: {
        symbol: market.symbol,
        source: market.source,
        price: market.price,
      },
      result,
      comparison,
      candles: market.candles,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 模拟交易（支持 Bitget Paper） ──
app.post("/api/paper/session", async (req, res) => {
  try {
    const sessionId = req.body.sessionId || `paper_${Date.now()}`;
    const strategy = req.body.strategy || null;
    const symbol = req.body.symbol || strategy?.symbol || "BTCUSDT";
    const session = await initBitgetSession(sessionId, symbol, strategy);
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/paper/:sessionId", (req, res) => {
  res.json(getOrCreateSession(req.params.sessionId));
});

app.post("/api/paper/:sessionId/tick", async (req, res) => {
  try {
    const { strategy } = req.body;
    const market = await getMarketSnapshot(strategy?.symbol || "BTCUSDT");
    const tick = await tickPaperSession(req.params.sessionId, market, strategy);
    res.json({ ...tick, market: { price: market.price, ma20: market.ma20 } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/paper/:sessionId/tick-all", async (req, res) => {
  try {
    const { strategies } = req.body || {};
    const session = getOrCreateSession(req.params.sessionId);
    const list =
      strategies?.length > 0
        ? strategies
        : Object.values(session.runningStrategies || {}).map((e) => e.strategy);
    if (!list.length) {
      return res.status(400).json({ error: "没有运行中的策略" });
    }
    for (const s of list) {
      addPaperStrategy(req.params.sessionId, s);
    }
    const symbols = [...new Set(list.map((s) => s.symbol).filter(Boolean))];
    const marketBySymbol = {};
    await Promise.all(
      symbols.map(async (sym) => {
        const m = await getMarketSnapshot(sym);
        marketBySymbol[sym] = m;
      })
    );
    const tick = await tickAllPaperStrategies(req.params.sessionId, marketBySymbol);
    res.json(tick);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/paper/:sessionId/strategies", async (req, res) => {
  try {
    const { strategy } = req.body;
    if (!strategy) return res.status(400).json({ error: "缺少 strategy" });
    const result = addPaperStrategy(req.params.sessionId, strategy);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/paper/:sessionId/strategies/:runId", async (req, res) => {
  try {
    const result = removePaperStrategy(req.params.sessionId, req.params.runId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/paper/:sessionId/order", async (req, res) => {
  try {
    const { side, price, strategy } = req.body;
    const session = getOrCreateSession(req.params.sessionId);
    const result = await executePaperOrder(session, { side, price, strategy });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/paper/:sessionId/resume", (req, res) => {
  const session = getOrCreateSession(req.params.sessionId);
  session.paused = false;
  session.logs.unshift({ time: Date.now(), message: "[系统] 风控暂停已解除", level: "info" });
  res.json(session);
});

// ── 市场数据 ──
app.get("/api/market/symbols", async (_req, res) => {
  try {
    const { getSpotSymbols } = await import("./services/bitgetClient.js");
    res.json({ symbols: await getSpotSymbols(), source: "bitget_api" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/market/:symbol?", async (req, res) => {
  try {
    const symbol = (req.params.symbol || "BTCUSDT").toUpperCase();
    const { granularity, limit, maPeriod, category } = req.query;
    res.json(
      await getMarketSnapshot(symbol, {
        granularity: granularity || "1H",
        limit: limit ? Number(limit) : 200,
        maPeriod: maPeriod ? Number(maPeriod) : 20,
        category: category || "USDT-FUTURES",
      })
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 自主 Agent 调度器 API ──
app.post("/api/agent/start", async (req, res) => {
  try {
    const { startAutonomousSession } = await import("./services/agentScheduler.js");
    const { symbol, strategy, intervalMs, config } = req.body || {};
    const result = startAutonomousSession({ symbol, strategy, intervalMs, config });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/stop/:sessionId", async (req, res) => {
  try {
    const { stopSession } = await import("./services/agentScheduler.js");
    res.json(stopSession(req.params.sessionId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/stop-all", async (_req, res) => {
  try {
    const { stopAllSessions } = await import("./services/agentScheduler.js");
    res.json(stopAllSessions());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agent/status", async (_req, res) => {
  try {
    const { getSchedulerStatus } = await import("./services/agentScheduler.js");
    res.json(getSchedulerStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agent/trace/:sessionId", async (req, res) => {
  try {
    const { getSessionTrace } = await import("./services/agentScheduler.js");
    res.json({ trace: getSessionTrace(req.params.sessionId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/agent/session/:sessionId", async (req, res) => {
  try {
    const { updateSessionConfig } = await import("./services/agentScheduler.js");
    res.json(updateSessionConfig(req.params.sessionId, req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agent 性能记忆 API ──
app.get("/api/agent/memory", async (_req, res) => {
  try {
    const { getMemory, getPerformanceSummary } = await import("./services/agentPerformanceMemory.js");
    const regime = _req.query.regime;
    res.json({
      memory: getMemory(),
      summary: regime ? getPerformanceSummary(regime) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/memory/reset", async (_req, res) => {
  try {
    const { resetMemory } = await import("./services/agentPerformanceMemory.js");
    res.json(resetMemory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GetAgent Cloud 上传代理（本地无法直连 api.bitget.com 时经 Railway 中转）
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

app.post("/api/getagent/upload", express.json({ limit: "20mb" }), async (req, res) => {
  try {
    const { accessKey, fileBase64 } = req.body;
    if (!accessKey || !fileBase64) {
      return res.status(400).json({ error: "Missing accessKey or fileBase64" });
    }
    const buffer = Buffer.from(fileBase64, "base64");
    const form = new FormData();
    const blob = new Blob([buffer], { type: "application/gzip" });
    form.set("package", blob, "gold-dip-buy.tar.gz");
    const response = await fetch("https://api.bitget.com/api/v1/playbook/upload", {
      method: "POST",
      headers: { "ACCESS-KEY": accessKey },
      body: form,
    });
    // Drain body
    const text = await response.text();
    // Clean up
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    res.status(response.status).json({ status: response.status, data: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GetAgent Cloud 运行回测代理
app.post("/api/getagent/run", express.json(), async (req, res) => {
  try {
    const { accessKey, versionId } = req.body;
    if (!accessKey || !versionId) {
      return res.status(400).json({ error: "Missing accessKey or versionId" });
    }
    const response = await fetch("https://api.bitget.com/api/v1/playbook/run", {
      method: "POST",
      headers: { "ACCESS-KEY": accessKey, "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionId }),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    res.status(response.status).json({ status: response.status, data: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 生产环境托管前端静态文件
const frontendDist = path.join(__dirname, "../frontend/dist");
app.use(express.static(frontendDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(frontendDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Bitget Agent Demo API → http://localhost:${PORT}`);
  console.log(`🤖 自主 Agent 调度器已加载 — 使用 POST /api/agent/start 启动`);
}).on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ 端口 ${PORT} 已被占用，请先关闭其他 backend 进程`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
