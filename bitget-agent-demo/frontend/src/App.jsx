import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api";
import Header from "./components/Header";
import StrategyChat from "./components/StrategyChat";
import SimApiConfigPanel from "./components/SimApiConfigPanel";
import ConnectionBanner from "./components/ConnectionBanner";
import { normalizeSymbol } from "./utils/symbols";
import { simLogToPanelEntry } from "./utils/simActivity";
import {
  strategyRunId,
  mergeRunningStrategy,
  removeRunningStrategy as dropRunningStrategy,
  withRunId,
} from "./utils/strategyRun";
import {
  loadRunningStrategies,
  saveRunningStrategies,
} from "./utils/runningStrategiesStorage";
import {
  loadCustomPresets,
  upsertCustomPresetFromStrategy,
  removeCustomPreset,
  getMyStrategiesList,
} from "./utils/customPresets";

const STORAGE_KEY = "bitget_agent_strategy";
const CHAT_STORAGE_KEY = "bitget_agent_chat_history";

const MAX_CHAT_HISTORY = 200; // 最多保留 200 条记录

export default function App() {
  const [hubStatus, setHubStatus] = useState(null);
  const [apiError, setApiError] = useState(null);
  const [strategy, setStrategy] = useState(null);
  const [chatSessionId, setChatSessionId] = useState(null);
  const [chatHistory, setChatHistory] = useState(() => {
    try {
      const saved = localStorage.getItem(CHAT_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [paperSession, setPaperSession] = useState(null);
  const [paperId] = useState(() => `paper_${Date.now()}`);
  const [loading, setLoading] = useState(false);
  const [runningStrategies, setRunningStrategies] = useState(() => loadRunningStrategies());
  const [customPresets, setCustomPresets] = useState(() => loadCustomPresets());
  const [focusedRunId, setFocusedRunId] = useState(null);
  const [perception, setPerception] = useState(null);
  const [lastAgentTick, setLastAgentTick] = useState(null);
  const [simStatus, setSimStatus] = useState(null);
  const [initDone, setInitDone] = useState(false);
  const [schedulerActive, setSchedulerActive] = useState(false);
  const [schedulerTrace, setSchedulerTrace] = useState(null);

  const paperRunning = runningStrategies.length > 0;
  const runningStrategiesRef = useRef(runningStrategies);
  runningStrategiesRef.current = runningStrategies;
  const tickInFlightRef = useRef(false);
  const lastTickAtRef = useRef(0);
  const paperTimer = useRef(null);
  const agentStoppedRef = useRef(false);
  const [agentTickAt, setAgentTickAt] = useState(null);

  useEffect(() => {
    if (lastAgentTick) setAgentTickAt(Date.now());
  }, [lastAgentTick]);

  // Persist chat history to localStorage
  useEffect(() => {
    if (chatHistory.length > 0) {
      try {
        const trimmed = chatHistory.slice(-MAX_CHAT_HISTORY);
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
      } catch { /* ignore quota errors */ }
    }
  }, [chatHistory]);

  const syncRunningStrategies = useCallback((next) => {
    setRunningStrategies(next);
    saveRunningStrategies(next);
  }, []);

  const refreshCustomPresets = useCallback(() => {
    setCustomPresets(loadCustomPresets());
  }, []);

  const applyTickResults = useCallback((results = []) => {
    const map = Object.fromEntries(results.map((r) => [r.runId, r]));
    return runningStrategiesRef.current.map((s) => {
      const runId = strategyRunId(s);
      const hit = map[runId];
      if (!hit) return s;
      if (hit.error) {
        return {
          ...s,
          lastAgent: s.lastAgent || {
            perceive: { summary: "等待感知…", score: 0, signalCount: 0 },
            decide: { finalAction: "hold", finalReason: `Tick 异常：${hit.error}` },
            risk: { passed: true, reason: "—" },
            execute: { executed: false },
            exit: { hasPosition: false, reason: "—" },
          },
        };
      }
      return hit.agent ? { ...s, lastAgent: hit.agent } : s;
    });
  }, []);

  const refreshSimContext = useCallback(async (symbol) => {
    try {
      const sym = symbol || strategy?.symbol || "BTCUSDT";
      const sim = await api.simStatus().catch(() => null);
      setSimStatus(sim);
      if (sim?.configured) {
        await api.simAllOrders([sym]).catch(() => null);
      }
    } catch (e) {
      console.error("sim context", e);
    }
  }, [strategy?.symbol]);

  const refreshSimAuth = useCallback(async () => {
    await refreshSimContext(strategy?.symbol);
    try {
      const session = await api.createPaperSession(paperId, strategy?.symbol || "BTCUSDT", strategy);
      setPaperSession(session);
    } catch {
      /* ignore */
    }
  }, [paperId, refreshSimContext, strategy?.symbol]);

  const refreshSimActivity = useCallback(async (extraSymbols = []) => {
    try {
      const status = await api.simStatus().catch(() => null);
      if (!status?.configured) return;
      const acct = await api.simAccount().catch(() => null);
      const logsRes = await api.simLogs(15).catch(() => ({ logs: [] }));
      const historyRes = await api.simHistoryOrders(
        [strategy?.symbol, ...runningStrategies.map((s) => s.symbol), ...(extraSymbols || [])].filter(Boolean),
        10
      ).catch(() => ({ orders: [] }));
      if (acct?.configured) setSimStatus((s) => ({ ...s, configured: true }));
      setPaperSession((s) => {
        const base = s || {};
        return {
          ...base,
          simApi: true,
          orders: historyRes.orders || [],
          logs: (logsRes.logs || []).map(simLogToPanelEntry).slice(0, 10),
          cash: Number(acct?.usdt?.available ?? base.cash ?? 0),
          holdings: acct?.configured
            ? {
                spot: acct.spotAssets || [],
                futures: acct.futuresPositions || [],
                accountEquity: acct.accountEquity,
                unrealisedPnl: acct.unrealisedPnl,
              }
            : base.holdings || {},
        };
      });
    } catch (e) {
      console.warn("sim activity refresh", e);
    }
  }, [strategy?.symbol, runningStrategies]);

  const bootstrap = useCallback(async () => {
    setApiError(null);
    let strat = null;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        strat = JSON.parse(saved);
        strat = { ...strat, symbol: normalizeSymbol(strat.symbol) };
      } catch {
        /* ignore */
      }
    }

    if (strat) {
      setStrategy(strat);
      upsertCustomPresetFromStrategy(strat);
      setCustomPresets(loadCustomPresets());
      setChatHistory((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `已恢复策略「${strat.name || strat.summary}」。说「启动策略」开始自动执行，或继续描述新策略。`,
          kind: "strategy",
          strategy: strat,
          time: Date.now(),
        },
      ]);
    }

    try {
      const health = await api.hubHealth();
      setHubStatus(health);
    } catch (e) {
      setApiError(e.message);
      setHubStatus({ status: "offline" });
      setInitDone(true);
      return;
    }

    try {
      await api.createPaperSession(paperId, strat?.symbol || "BTCUSDT", strat).then(setPaperSession).catch(() => null);
      await refreshSimContext(strat?.symbol);
    } catch (e) {
      console.warn("bootstrap sim context", e);
    }
    setInitDone(true);
  }, [paperId, refreshSimContext]);

  useEffect(() => {
    bootstrap();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initDone) return;
    const sym = strategy?.symbol || "BTCUSDT";
    let perceiveFreshAt = 0;
    const load = () => {
      const now = Date.now();
      if (now - perceiveFreshAt < 5000) return; // 5s perception cooldown
      api
        .hubPerception(sym, false)
        .then((r) => {
          if (r?.data) {
            perceiveFreshAt = now;
            setPerception(r.data);
          }
        })
        .catch(() => null);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [initDone, strategy?.symbol]);

  useEffect(() => {
    if (!initDone || !simStatus?.configured) return;
    refreshSimActivity([strategy?.symbol]);
    const t = setInterval(() => refreshSimActivity([strategy?.symbol]), 8000);
    return () => clearInterval(t);
  }, [initDone, simStatus?.configured, strategy?.symbol, refreshSimActivity]);

  const runPaperTickAll = useCallback(async (list) => {
    if (tickInFlightRef.current || agentStoppedRef.current) return null;
    const strats = (list?.length ? list : runningStrategiesRef.current).map(withRunId);
    if (!strats.length) return null;
    tickInFlightRef.current = true;
    try {
      const result = await api.tickAllPaper(paperId, strats);
      setPaperSession(result.session);
      syncRunningStrategies(applyTickResults(result.results || []));
      const perceptionHit = (result.results || []).find(
        (r) => r.perception?.skills || r.perception?.composite || r.perception?.deepseekPerception
      );
      if (perceptionHit?.perception) setPerception(perceptionHit.perception);
      const focusId = focusedRunId || strats[0]?.runId;
      const focusHit =
        (result.results || []).find((r) => r.runId === focusId) || (result.results || [])[0];
      if (focusHit?.agent) {
        setLastAgentTick(focusHit.agent);
        lastTickAtRef.current = Date.now();
      } else if (focusHit?.simTick?.agent) {
        setLastAgentTick(focusHit.simTick.agent);
        lastTickAtRef.current = Date.now();
      }
      await refreshSimActivity(runningStrategiesRef.current.map((s) => s.symbol));
      return result;
    } catch (e) {
      setApiError(e.message);
      return null;
    } finally {
      tickInFlightRef.current = false;
    }
  }, [paperId, refreshSimActivity, syncRunningStrategies, applyTickResults, focusedRunId]);

  const addRunningStrategy = useCallback(
    async (strat, opts = { tick: true }) => {
      if (!strat) return null;
      agentStoppedRef.current = false;
      const stamped = withRunId(strat);
      const next = mergeRunningStrategy(runningStrategiesRef.current, stamped);
      syncRunningStrategies(next);
      setFocusedRunId(strategyRunId(stamped));
      setStrategy(stamped);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
      upsertCustomPresetFromStrategy(stamped);
      refreshCustomPresets();
      if (!simStatus?.configured) return next;
      try {
        await api.createPaperSession(paperId, stamped.symbol, stamped);
        await api.addPaperStrategy(paperId, stamped);
        if (opts.tick) await runPaperTickAll(next);
      } catch (e) {
        setApiError(e.message);
      }
      return next;
    },
    [paperId, simStatus?.configured, runPaperTickAll, syncRunningStrategies, refreshCustomPresets]
  );

  const stopRunningStrategy = useCallback(
    async (runId) => {
      const next = dropRunningStrategy(runningStrategiesRef.current, runId);
      syncRunningStrategies(next);
      try {
        const { session } = await api.removePaperStrategy(paperId, runId);
        setPaperSession(session);
      } catch {
        /* ignore */
      }
    },
    [paperId, syncRunningStrategies]
  );

  const stopAllStrategies = useCallback(
    async (opts = {}) => {
      const { notifyChat = false } = opts;
      const runIds = runningStrategiesRef.current.map(strategyRunId);

      agentStoppedRef.current = true;
      setLoading(false);

      syncRunningStrategies([]);
      setLastAgentTick(null);
      setAgentTickAt(null);
      setPerception(null);
      setFocusedRunId(null);
      setPaperSession((s) => (s ? { ...s, lastAgentTick: null } : s));
      if (paperTimer.current) {
        clearInterval(paperTimer.current);
        paperTimer.current = null;
      }

      if (simStatus?.configured && runIds.length) {
        for (const runId of runIds) {
          try {
            const { session } = await api.removePaperStrategy(paperId, runId);
            setPaperSession(session);
          } catch {
            /* ignore */
          }
        }
      }

      if (notifyChat) {
        setChatHistory((h) => [
          ...h,
          {
            role: "assistant",
            content: "已停止全部自动策略（含自主运行与后台 tick）。",
            kind: "info",
            time: Date.now(),
          },
        ]);
      }

      // 同时停止自主 Agent 调度器
      try {
        await api.agentStopAll();
      } catch { /* ignore */ }
      setSchedulerActive(false);
      setSchedulerTrace(null);

      return {};
    },
    [paperId, simStatus?.configured, syncRunningStrategies]
  );

  useEffect(() => {
    if (!initDone || !simStatus?.configured || !runningStrategies.length) return;
    let cancelled = false;
    (async () => {
      try {
        for (const s of runningStrategies) {
          if (cancelled) return;
          await api.addPaperStrategy(paperId, withRunId(s));
        }
        const session = await api.createPaperSession(
          paperId,
          runningStrategies[0]?.symbol || "BTCUSDT",
          runningStrategies[0]
        );
        if (!cancelled) setPaperSession(session);
      } catch (e) {
        if (!cancelled) setApiError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initDone, simStatus?.configured, paperId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!runningStrategies.length) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || tickInFlightRef.current) return;
      await runPaperTickAll();
    };
    tick();
    paperTimer.current = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(paperTimer.current);
    };
  }, [runningStrategies.length, runPaperTickAll]);

  // ── 自主调度器轮询 ──
  const schedulerTimerRef = useRef(null);

  const startScheduler = useCallback(async (symOrStrategy) => {
    try {
      const sym = typeof symOrStrategy === "string"
        ? symOrStrategy
        : (symOrStrategy?.symbol || strategy?.symbol || "BTCUSDT");
      const selStrategy = typeof symOrStrategy === "object" ? symOrStrategy : strategy;
      const result = await api.agentStart({ symbol: sym, strategy: selStrategy || undefined });
      if (result.ok) {
        setSchedulerActive(true);
        setSchedulerTrace(null);
        setChatHistory((h) => [...h, {
          role: "assistant",
          content: `自主 Agent 已启动 ${sym.replace("USDT", "")} · 感知→思考→决策→执行循环`,
          kind: "info",
          time: Date.now(),
        }]);
      }
    } catch (e) {
      setApiError(e.message);
    }
  }, [strategy]);

  const stopScheduler = useCallback(async () => {
    try {
      await api.agentStopAll();
      setSchedulerActive(false);
      setSchedulerTrace(null);
      setChatHistory((h) => [...h, {
        role: "assistant",
        content: "自主 Agent 已停止，等待主人重启信号",
        kind: "info",
        time: Date.now(),
      }]);
    } catch (e) {
      setApiError(e.message);
    }
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const status = await api.agentStatus();
        const running = status?.sessions?.filter((s) => s.status === "running") || [];
        setSchedulerActive(running.length > 0);
        if (running.length > 0) {
          const first = running[0];
          const traceRes = await api.agentTrace(first.id).catch(() => null);
          if (traceRes?.trace) {
            setSchedulerTrace(traceRes.trace);
          }
        } else {
          setSchedulerTrace(null);
        }
      } catch { /* ignore */ }
    };
    poll();
    schedulerTimerRef.current = setInterval(poll, 5000);
    return () => clearInterval(schedulerTimerRef.current);
  }, []);

  const handleSelectSavedStrategy = useCallback((s) => {
    if (!s) return;
    setStrategy(s);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    setChatHistory((h) => [
      ...h,
      {
        role: "assistant",
        content: `已切换到「${s.name || s.symbol}」`,
        kind: "strategy",
        strategy: s,
        time: Date.now(),
      },
    ]);
  }, []);

  const handleDeleteSavedStrategy = useCallback(
    (id, meta = {}) => {
      const list = loadCustomPresets();
      const target =
        (meta.symbol &&
          list.find(
            (p) => p.symbol === meta.symbol && (p.type || "custom") === (meta.type || "custom")
          )) ||
        (id ? list.find((p) => p.id === id) : null);

      removeCustomPreset(id, { symbol: meta.symbol, type: meta.type });
      refreshCustomPresets();

      const remaining = loadCustomPresets();
      const deletedCurrent =
        (target && strategy?.id === target.id) ||
        (meta.symbol &&
          strategy?.symbol === meta.symbol &&
          (strategy?.type || "custom") === (meta.type || "custom")) ||
        (id && strategy?.id === id);

      if (deletedCurrent) {
        if (remaining.length) {
          handleSelectSavedStrategy(remaining[0]);
        } else {
          setStrategy(null);
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    },
    [strategy?.id, strategy?.symbol, strategy?.type, refreshCustomPresets, handleSelectSavedStrategy]
  );

  const handleParse = async (message) => {
    const trimmed = (message || "").trim();
    if (!trimmed) return;

    if (!/^(停止全部|全部停止|停止策略)$/.test(trimmed)) {
      agentStoppedRef.current = false;
    }

    if (/^(停止全部|全部停止|停止策略)/.test(trimmed)) {
      setChatHistory((h) => [...h, { role: "user", content: trimmed, time: Date.now() }]);
      await stopAllStrategies({ notifyChat: true });
      return;
    }

    if (loading) return;

    if (/^我的策略$/.test(trimmed)) {
      const list = getMyStrategiesList(strategy);
      setChatHistory((h) => [
        ...h,
        { role: "user", content: trimmed, time: Date.now() },
        {
          role: "assistant",
          content: list.length
            ? `已保存 ${list.length} 个策略，点击切换：`
            : "还没有保存的策略。对话中创建或生成策略后会自动保存到这里。",
          kind: "my_strategies",
          time: Date.now(),
        },
      ]);
      return;
    }

    if (/^启动策略/.test(trimmed) && strategy && simStatus?.configured) {
      setChatHistory((h) => [...h, { role: "user", content: trimmed, time: Date.now() }]);
      await addRunningStrategy(strategy, { tick: true });
      setChatHistory((h) => [
        ...h,
        {
          role: "assistant",
          content: `已启动「${strategy.name}」· 每 3 秒自动 tick · 感知→决策→执行→风控→退出`,
          kind: "strategy",
          strategy,
          time: Date.now(),
        },
      ]);
      return;
    }

    setChatHistory((h) => [...h, { role: "user", content: trimmed, time: Date.now() }]);
    setLoading(true);
    setApiError(null);

    try {
      const data = await api.chatMessage({
        message: trimmed,
        sessionId: chatSessionId,
        previousStrategy: strategy,
        forcePerception: /扫描|感知/.test(trimmed),
      });
      setChatSessionId(data.sessionId);
      setChatHistory(data.history);

      if (data.strategy) {
        setStrategy(data.strategy);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data.strategy));
        upsertCustomPresetFromStrategy(data.strategy);
        refreshCustomPresets();
        if (runningStrategiesRef.current.length) {
          const next = runningStrategiesRef.current.map((s) =>
            s.symbol === data.strategy.symbol && s.type === data.strategy.type
              ? {
                  ...s,
                  leverage: data.strategy.leverage,
                  marginMode: data.strategy.marginMode,
                  category: data.strategy.category,
                }
              : s
          );
          syncRunningStrategies(next);
        }
        if (data.action?.autoStartPaper) {
          await addRunningStrategy(data.strategy, { tick: true });
        }
      }

      const kind = data.action?.kind;
      if (kind === "scan" && data.action?.perception) setPerception(data.action.perception);
      if (kind === "strategy" && data.action?.perception) setPerception(data.action.perception);
      if (kind === "market" && data.action?.perception) setPerception(data.action.perception);
      if (kind === "chat" && data.action?.perception) setPerception(data.action.perception);

      if (kind === "tick" && data.action?.agent) {
        setChainDismissed(false);
        setLastAgentTick(data.action.agent);
        lastTickAtRef.current = Date.now();
        const snap = data.action.tick?.perceptionSnapshot || data.action.perception;
        if (snap) setPerception(snap);
      }

      if (kind === "tick" && data.strategy) {
        upsertCustomPresetFromStrategy(data.strategy);
        refreshCustomPresets();
      }

      if (["account", "trade", "cancel", "tick", "multi_trade", "orders"].includes(kind)) {
        const tradeSyms = [];
        if (data.action?.trade?.symbol) tradeSyms.push(data.action.trade.symbol);
        if (data.action?.trades?.length) {
          for (const t of data.action.trades) {
            if (t.symbol) tradeSyms.push(t.symbol);
          }
        }
        // 立即刷新（后端本地账本已同步）
        await refreshSimActivity(tradeSyms.length ? tradeSyms : [data.strategy?.symbol || strategy?.symbol]);
      }
    } catch (e) {
      setApiError(e.message);
      setChatHistory((h) => [
        ...h,
        { role: "assistant", content: `请求失败：${e.message}`, kind: "error", time: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const focused =
    runningStrategies.find((s) => strategyRunId(s) === focusedRunId) ||
    runningStrategies[0] ||
    strategy;
  const autoAgent = schedulerTrace
    ? schedulerTrace
    : schedulerActive
      ? {
          perceive: { deepseekUsed: true, summary: "自主Agent即将执行首轮分析…" },
          decide: { finalAction: "hold", finalReason: "首轮分析中…", deepseekUsed: true },
          risk: { ok: true, passed: true, reason: "等待首轮分析…" },
          exit: { hasPosition: false, reason: "—" },
          execute: { executed: false, error: null },
          autonomous: true,
          source: "scheduler",
        }
      : lastAgentTick || focused?.lastAgent || paperSession?.lastAgentTick || null;
  // Merge latest independent perception into agent's perceive so score updates in real-time
  const livePerceive = perception && perception.composite ? {
    ...autoAgent?.perceive,
    bias: perception.composite.bias,
    score: perception.composite.score,
    summary: perception.deepseekPerception?.summary || perception.composite.summary || autoAgent?.perceive?.summary,
    signalCount: perception.composite.signals?.length || autoAgent?.perceive?.signalCount,
    deepseekUsed: perception.deepseekUsed !== undefined ? perception.deepseekUsed : autoAgent?.perceive?.deepseekUsed,
  } : autoAgent?.perceive;
  const lastAgent = autoAgent ? { ...autoAgent, perceive: livePerceive } : autoAgent;

  return (
    <div className="min-h-screen bg-paper">
      <Header hubStatus={hubStatus} />

      <main className="mx-auto max-w-3xl px-4 py-4 lg:px-6">
        <ConnectionBanner hubStatus={hubStatus} apiError={apiError} onRetry={bootstrap} />

        <div className="mb-4">
          <SimApiConfigPanel simStatus={simStatus} onAuthChange={refreshSimAuth} />
        </div>

        <StrategyChat
          history={chatHistory}
          onSend={handleParse}
          loading={loading}
          strategy={strategy}
          perception={perception}
          simStatus={simStatus}
          paperRunning={paperRunning}
          runningStrategies={runningStrategies}
          customPresets={getMyStrategiesList(strategy)}
          lastAgent={lastAgent}
          lastAgentTickAt={agentTickAt}
          onStopAll={() => stopAllStrategies({ notifyChat: true })}
          onStopStrategy={stopRunningStrategy}
          onStartStrategy={() => strategy && addRunningStrategy(strategy, { tick: true })}
          onSelectSavedStrategy={handleSelectSavedStrategy}
          onDeleteSavedStrategy={handleDeleteSavedStrategy}
          onOrderCancelled={(order) => {
            refreshSimActivity([order?.symbol]).catch(() => null);
          }}
          schedulerActive={schedulerActive}
          onStartScheduler={startScheduler}
          onStopScheduler={stopScheduler}
        />
      </main>

      <footer className="border-t border-bitget-border py-3 text-center text-xs text-ink-faint">
        逆天 Agent · 模拟交易，无真实资金
      </footer>
    </div>
  );
}
