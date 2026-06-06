import { useState, useRef, useEffect, useMemo } from "react";
import { SignalScanCard, StrategyUpdateCard, StrategyCheckCard } from "./StrategyScanCard";
import AgentStatusBar from "./AgentStatusBar";
import AgentLoopCard from "./AgentLoopCard";
import { strategyRunId } from "../utils/strategyRun";
import { hideModelTerms, agentStepFlags } from "../utils/agentDisplay";
import AgentIcon from "./AgentIcon";
import XianIcon from "./XianIcon";
import {
  HelpCard,
  AccountCard,
  OrdersCard,
  FuturesCard,
  TradeCard,
  MarketCard,
  PnlCard,
  LogsCard,
  StrategyTradesCard,
  TickCard,
  MultiTradeCard,
  SymbolsCard,
  MyStrategiesCard,
  CancelCard,
  SimRequiredCard,
  StatusCard,
} from "./BotActionCards";

const BOT_NAME = "逆天 Agent";

const BASE_MENU_ITEMS = [
  { id: "scan", icon: "scan", label: "信号扫描", desc: "全 USDT 现货 · 如：扫描 WLD / 扫描 PEPE" },
  { icon: "wallet", label: "我的资产", text: "我的资产", desc: "现货 + 合约持仓明细" },
  { icon: "list", label: "我的挂单", text: "我的挂单", desc: "全资产未成交委托" },
  { icon: "link", label: "可交易对", text: "可交易对列表", desc: "Bitget 在线 USDT 对" },
  { icon: "long", label: "合约开多", text: "市价单1x杠杆100u保证金多btc", desc: "USDT 永续开多 · 不受感知拦截" },
  { icon: "close-long", label: "平多 BTC", text: "平多 BTC", desc: "市价全平 BTC 多单 · 不受感知拦截" },
  { icon: "explode", label: "平掉全部仓位", text: "平掉全部仓位", desc: "合约一键平仓 · 不受感知拦截" },
  { icon: "cancel", label: "撤销全部挂单", text: "撤销全部挂单", desc: "扫描并撤销所有挂单" },
  { icon: "brain", label: "自主生成策略", text: "生成 BTC 策略", desc: "Agent 分析市场并自动设计策略" },
  { icon: "collection", label: "我的策略", text: "我的策略", desc: "已保存策略列表 · 点击切换" },
  { icon: "play", label: "启动策略", text: "启动策略", desc: "自动 tick · 每 3 秒一轮完整链路" },
  { icon: "stop", label: "停止全部", text: "停止全部策略", desc: "停止所有自动运行策略" },
  { icon: "brain", label: "启动自主Agent", text: "启动自主Agent", desc: "完全自主感知→决策→执行循环" },
  { icon: "stop", label: "停止自主Agent", text: "停止自主", desc: "停止完全自主执行循环" },
  { icon: "chart-down", label: "盈亏分析", text: "盈亏分析", desc: "Bitget 实时 · 现货/合约 · 7/30/180 日" },
  { icon: "journal", label: "模拟交易日志", text: "模拟交易日志", desc: "Bitget 实时 · 每笔可查 orderId" },
  { icon: "help", label: "功能帮助", text: "帮助", desc: "查看全部指令" },
];

const STARTER_PROMPTS = [
  "生成 BTC 策略",
  "扫描 WLD",
  "WLD突破20日均线且成交量放大1.5倍时买入40%仓位",
  "PEPE网格间距2%，总仓位25%",
  "把策略换成 AAVE",
];

function BotAvatar({ small }) {
  return <AgentIcon size={small ? "sm" : "md"} rounded="full" />;
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function MessageCards({ msg, strategy, perception, lastAgent, customPresets, runningStrategies, onSelectSavedStrategy, onDeleteSavedStrategy, onOrderCancelled }) {
  const kind = msg.kind || (msg.strategy ? "strategy" : null);
  const p = msg.perception || perception;
  const mkt = msg.market;

  if (kind === "scan") {
    const scanSymbol = msg.symbol || msg.market?.symbol || mkt?.symbol;
    return (
      <SignalScanCard
        symbol={scanSymbol}
        market={msg.market || mkt}
        perception={msg.perception || p}
      />
    );
  }
  if (kind === "strategy" && (msg.strategy || strategy)) {
    const strat = msg.strategy || strategy;
    return (
      <>
        <StrategyUpdateCard
          strategy={strat}
          perception={msg.perception || p}
          lastAgent={lastAgent}
          autonomousThought={msg.autonomousThought || strat?.autonomousThought}
        />
        {msg.strategyCheck && (
          <StrategyCheckCard
            check={msg.strategyCheck}
            title={
              strat?.type === "breakout_trend"
                ? "突破趋势条件校验"
                : strat?.type === "sar_macd"
                  ? "SAR+MACD 条件校验"
                  : "策略条件校验"
            }
          />
        )}
        {(msg.perception || p) && (
          <SignalScanCard
            symbol={msg.symbol || strat?.symbol}
            market={msg.market || mkt}
            perception={msg.perception || p}
          />
        )}
      </>
    );
  }
  if (kind === "account") {
    if (msg.account?.configured !== false && msg.account?.spotAssets) {
      return <AccountCard account={msg.account} />;
    }
    return <SimRequiredCard message={msg.content} />;
  }
  if (kind === "orders") return <OrdersCard orders={msg.orders} onCancelled={onOrderCancelled} />;
  if (kind === "futures") return <FuturesCard positions={msg.positions} />;
  if (kind === "trade" || kind === "trade_blocked") {
    return <TradeCard trade={msg.trade} blocked={kind === "trade_blocked"} />;
  }
  if (kind === "market") return <MarketCard market={mkt} perception={p} />;
  if (kind === "pnl") return <PnlCard pnl={msg.pnl} />;
  if (kind === "logs") return <LogsCard entries={msg.entries} logs={msg.logs} meta={msg.meta} />;
  if (kind === "strategy_trades") return <StrategyTradesCard trades={msg.trades} summary={msg.summary} meta={msg.meta} />;
  if (kind === "my_strategies") {
    return (
      <MyStrategiesCard
        strategies={customPresets}
        activeStrategy={strategy}
        runningStrategies={runningStrategies}
        onSelect={onSelectSavedStrategy}
        onDelete={onDeleteSavedStrategy}
      />
    );
  }
  if (kind === "tick") {
    const strat = msg.strategy || strategy;
    const tickAgent = msg.agent || msg.tick?.agent || lastAgent;
    return (
      <>
        {strat && (
          <StrategyUpdateCard
            strategy={strat}
            perception={msg.perception || p}
            lastAgent={tickAgent}
            autonomousThought={
              msg.autonomousThought || tickAgent?.decide?.autonomousThought || strat?.autonomousThought
            }
          />
        )}
        {msg.strategyCheck && (
          <StrategyCheckCard
            check={msg.strategyCheck}
            title={
              strat?.type === "breakout_trend"
                ? "突破趋势条件校验"
                : strat?.type === "sar_macd"
                  ? "SAR+MACD 条件校验"
                  : "策略条件校验"
            }
          />
        )}
        <TickCard tick={msg.tick} agent={tickAgent} />
      </>
    );
  }
  if (kind === "multi_trade") return <MultiTradeCard trades={msg.trades} />;
  if (kind === "symbols") return <SymbolsCard symbols={msg.symbols} total={msg.symbolTotal} />;
  if (kind === "help") return <HelpCard capabilities={msg.capabilities} />;
  if (kind === "cancel") return <CancelCard content={msg.content} results={msg.results} symbol={msg.symbol} />;
  if (kind === "status") return <StatusCard status={msg.status} content={msg.content} />;
  if (kind === "error") {
    return (
      <div className="mt-2 rounded-lg border border-loss/30 bg-loss/5 px-3 py-2 text-xs text-ink-muted">
        若持续失败：请确认后端 <code className="text-bitget">npm run dev</code> 已启动，模拟 API 已连接。
      </div>
    );
  }
  return null;
}

function ChatBubble({ msg, strategy, perception, lastAgent, customPresets, runningStrategies, onSelectSavedStrategy, onDeleteSavedStrategy, onOrderCancelled }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[85%]">
          <div className="rounded-2xl rounded-tr-md bg-bitget/12 px-3.5 py-2.5 text-[15px] leading-relaxed text-ink-soft">
            {msg.content}
          </div>
          {msg.time && (
            <div className="mt-0.5 text-right text-[10px] text-ink-faint">{formatTime(msg.time)} ✓✓</div>
          )}
        </div>
      </div>
    );
  }

  const cards = MessageCards({
    msg,
    strategy,
    perception,
    lastAgent,
    customPresets,
    runningStrategies,
    onSelectSavedStrategy,
    onDeleteSavedStrategy,
    onOrderCancelled,
  });
  const isError = msg.kind === "error";

  return (
    <div className="flex gap-2.5">
      <BotAvatar small />
      <div className="min-w-0 max-w-[92%] flex-1">
        <div className="mb-0.5 text-[11px] font-medium text-bitget">{BOT_NAME}</div>
        <div
          className={`rounded-2xl rounded-tl-md border px-3.5 py-2.5 ${
            isError
              ? "border-loss/40 bg-loss/10"
              : "border-bitget-border/50 bg-bitget-panel"
          }`}
        >
          {msg.content && (
            <p
              className={`text-[15px] leading-relaxed whitespace-pre-wrap ${
                isError ? "text-loss" : "text-ink-soft"
              }`}
            >
              {hideModelTerms(msg.content)}
            </p>
          )}
          {cards}
        </div>
        {msg.time && <div className="mt-0.5 text-[10px] text-ink-faint">{formatTime(msg.time)}</div>}
      </div>
    </div>
  );
}

export default function StrategyChat({
  history,
  onSend,
  loading,
  strategy,
  perception,
  simStatus,
  paperRunning = false,
  runningStrategies = [],
  customPresets = [],
  lastAgent = null,
  onStopAll,
  onStopStrategy,
  onStartStrategy,
  onSelectSavedStrategy,
  onDeleteSavedStrategy,
  onOrderCancelled,
  lastAgentTickAt = null,
  schedulerActive = false,
  onStartScheduler,
  onStopScheduler,
}) {
  const [input, setInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loopOpen, setLoopOpen] = useState(false);
  const scrollRef = useRef(null);
  const prevHistoryLen = useRef(0);
  const menuRef = useRef(null);
  const heightClass = "h-[calc(100vh-180px)] min-h-[520px]";

  const showTradingChain =
    paperRunning || schedulerActive || !!lastAgent;
  const chainAgent = lastAgent;
  const chainRunning = paperRunning || schedulerActive;

  const loopSummary = useMemo(() => {
    const flags = agentStepFlags(lastAgent);
    const perceiveOk =
      lastAgent?.perceive?.deepseekUsed || perception?.deepseekUsed ? "感知✓" : "感知—";
    const decideOk = flags.decideDone ? "决策✓" : "决策—";
    const execOk = flags.executeDone
      ? "执行✓"
      : flags.executeSkipped
        ? "执行—"
        : lastAgent?.execute?.error
          ? "执行✗"
          : "执行—";
    const riskOk = flags.riskDone ? "风控✓" : flags.riskFailed ? "风控✗" : flags.riskSkipped ? "风控—" : "风控—";
    const exitOk = flags.exitDone ? "退出✓" : flags.exitMonitoring ? "退出中" : flags.exitSkipped ? "退出—" : "退出—";
    if (!chainAgent) {
      return `${perceiveOk} · ${decideOk} · ${
        paperRunning ? "等待首轮 tick…" : "就绪"
      }`;
    }
    const { perceive, decide, risk, execute, exit } = chainAgent;
    const actionLabel =
      exit?.hasPosition && decide?.finalAction === "hold"
        ? "持仓"
        : decide?.displayAction === "hold_position"
          ? "持仓"
          : decide?.finalAction === "hold"
            ? "观望"
            : decide?.finalAction || "—";
    const parts = [
      perceiveOk,
      decideOk,
      execOk,
      riskOk,
      exitOk,
      hideModelTerms(perceive?.summary?.slice(0, 12)) || "—",
      actionLabel,
      execute?.executed ? "已成交" : execute?.error ? "未成交" : "未下单",
      risk?.paused ? "风控暂停" : risk?.passed === false ? "风控拦截" : "",
    ];
    return parts.filter(Boolean).join(" · ");
  }, [chainAgent, lastAgent, paperRunning, perception?.deepseekUsed]);

  useEffect(() => {
    if (paperRunning || schedulerActive) setLoopOpen(true);
  }, [paperRunning, schedulerActive]);

  useEffect(() => {
    if (!showTradingChain) setLoopOpen(false);
  }, [showTradingChain]);

  const menuItems = useMemo(() => {
    const coin = strategy?.symbol?.replace(/USDT$/i, "") || "BTC";
    return BASE_MENU_ITEMS.map((item) =>
      item.id === "scan"
        ? { ...item, text: `扫描 ${coin}`, label: item.label }
        : item
    );
  }, [strategy?.symbol]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const grew = history.length > prevHistoryLen.current;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (grew || nearBottom) {
      box.scrollTop = box.scrollHeight;
    }
    prevHistoryLen.current = history.length;
  }, [history]);

  useEffect(() => {
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const submit = (text) => {
    const msg = text || input.trim();
    if (!msg || loading) return;

    // 处理启动/停止自主 Agent
    if (/^启动自主/.test(msg)) {
      if (onStartScheduler) onStartScheduler(strategy?.symbol);
      setInput("");
      setMenuOpen(false);
      return;
    }
    if (/^停止自主/.test(msg) && schedulerActive && onStopScheduler) {
      onStopScheduler();
      setInput("");
      setMenuOpen(false);
      return;
    }

    onSend(msg);
    setInput("");
    setMenuOpen(false);
  };

  return (
    <div className={`panel flex ${heightClass} flex-col overflow-hidden`}>
      <div className="flex shrink-0 items-center gap-3 border-b border-bitget-border px-4 py-3">
        <BotAvatar />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink">{BOT_NAME}</div>
          <div className="mt-1.5">
            <AgentStatusBar
              perception={perception}
              lastAgent={chainAgent}
              compact
            />
          </div>
        </div>
        {paperRunning && (
          <span className="shrink-0 rounded-full bg-profit/15 px-2 py-0.5 text-[10px] text-profit">
            自动运行中
          </span>
        )}
        {schedulerActive && (
          <span className="shrink-0 rounded-full bg-bitget/15 px-2 py-0.5 text-[10px] text-bitget flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bitget" />
            自主Agent
            {onStopScheduler && (
              <button onClick={onStopScheduler} className="ml-0.5 text-ink-faint hover:text-loss text-[9px]">×</button>
            )}
          </span>
        )}
      </div>

      {!paperRunning && strategy && simStatus?.configured && onStartStrategy && (
        <div className="shrink-0 border-b border-bitget-border px-3 py-2">
          <button
            type="button"
            onClick={onStartStrategy}
            className="flex w-full items-center gap-2 rounded-lg border border-primary/25 bg-primary/8 py-2 text-xs text-primary hover:bg-primary/12"
          >
            <XianIcon name="play" size={14} className="text-primary" />
            启动「{strategy.name || strategy.symbol}」自动执行
          </button>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-paper-sub/60 px-3 py-4 space-y-4">
        {history.length === 0 && (
          <div className="flex gap-2.5">
            <BotAvatar small />
            <div className="max-w-[92%] rounded-2xl rounded-tl-md border border-bitget-border/50 bg-bitget-panel px-3.5 py-3">
              <p className="text-[15px] leading-relaxed text-ink-soft">
                你好，我是逆天 Agent 👋
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                执行层已内置：描述策略、扫描行情、买卖下单、自动 tick 均在对话中完成。先连接上方模拟 API。
              </p>
              <div className="mt-2 space-y-1.5">
                {STARTER_PROMPTS.map((ex, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => submit(ex)}
                    className="block w-full rounded-lg border border-bitget-border/60 bg-bitget-panel/40 px-3 py-2 text-left text-xs text-ink-body hover:border-bitget/40"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {history.map((msg, i) => (
          <ChatBubble
            key={`${msg.time}-${i}`}
            msg={msg}
            strategy={strategy}
            perception={perception}
            lastAgent={lastAgent}
            customPresets={customPresets}
            runningStrategies={runningStrategies}
            onSelectSavedStrategy={onSelectSavedStrategy}
            onDeleteSavedStrategy={onDeleteSavedStrategy}
            onOrderCancelled={onOrderCancelled}
          />
        ))}

        {loading && (
          <div className="flex gap-2.5">
            <BotAvatar small />
            <div className="rounded-2xl rounded-tl-md border border-bitget-border/50 bg-bitget-panel px-4 py-3">
              <div className="flex gap-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-bitget [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-bitget [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-bitget" />
              </div>
            </div>
          </div>
        )}
      </div>

      {showTradingChain && (
        <div className="shrink-0 border-t border-bitget-border bg-bitget-panel/40 px-3 pt-2">
          <AgentStatusBar perception={perception} lastAgent={chainAgent} />
          <button
            type="button"
            onClick={() => setLoopOpen((o) => !o)}
            className="mt-1.5 flex w-full items-center justify-between gap-2 py-2 text-left text-xs hover:bg-bitget/5"
          >
            <span className="truncate text-ink-muted">
              <span className="text-bitget font-medium">执行状态</span>
              <span className="mx-2 text-ink-faint">|</span>
              {loopSummary}
            </span>
            <span className="shrink-0 text-ink-faint">{loopOpen ? "收起 ▲" : "展开 ▼"}</span>
          </button>
          {loopOpen && (
            <div className="max-h-[240px] overflow-y-auto border-t border-bitget-border/50 pb-2">
              {simStatus?.configured && (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-bitget/20 bg-bitget/5 px-3 py-1.5">
                  <div className="text-[10px] text-ink-muted">
                    {paperRunning ? (
                      <>
                        <span className="text-profit">{runningStrategies.length} 策略运行中</span>
                        <span className="mx-1">·</span>每 3s tick
                      </>
                    ) : schedulerActive ? (
                      <span className="text-bitget">自主 Agent 运行中</span>
                    ) : (
                      <span className="text-ink-faint">空闲</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {runningStrategies.map((s) => (
                      <span
                        key={strategyRunId(s)}
                        className="inline-flex items-center gap-1 rounded-full bg-paper-sub/90 px-2 py-0.5 text-[10px] text-ink-body"
                      >
                        {s.name || s.symbol}
                        {onStopStrategy && (
                          <button
                            type="button"
                            className="text-loss"
                            onClick={(e) => {
                              e.stopPropagation();
                              onStopStrategy(strategyRunId(s));
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {onStopAll && (
                      <button
                        type="button"
                        className="text-[10px] text-loss"
                        onClick={onStopAll}
                        title="停止全部：含自主一轮、后台 tick、运行中策略"
                      >
                        全部停止
                      </button>
                    )}
                  </div>
                </div>
              )}
              <AgentLoopCard
                agent={chainAgent}
                running={chainRunning}
                updatedAt={lastAgentTickAt}
              />
            </div>
          )}
        </div>
      )}

      <div className="relative shrink-0 border-t border-bitget-border bg-bitget-panel/80 p-3" ref={menuRef}>
        {menuOpen && (
          <div className="absolute bottom-full left-3 right-3 mb-2 max-h-[320px] overflow-hidden rounded-xl border border-bitget-border bg-bitget-panel shadow-float">
            <div className="border-b border-bitget-border px-3 py-2">
              <div className="text-xs font-medium text-ink-faint">逆天 Agent · 内置执行层</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${simStatus?.configured ? "bg-profit" : "bg-warn"}`}
                />
                <span className={simStatus?.configured ? "text-ink-muted" : "text-warn"}>
                  {simStatus?.configured ? "模拟 API 已连接 · 点击即执行" : "模拟 API 未连接 · 查资产/交易需先配置"}
                </span>
              </div>
            </div>
            <div className="max-h-[260px] overflow-y-auto p-1">
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => submit(item.text)}
                  disabled={loading}
                  className="flex w-full flex-col rounded-lg px-3 py-2.5 text-left hover:bg-bitget/10 disabled:opacity-50"
                >
                  <span className="flex items-center gap-2 text-sm text-ink-soft">
                    {item.icon && <XianIcon name={item.icon} size={15} />}
                    {item.label}
                  </span>
                  {item.desc && <span className="text-[11px] text-ink-faint">{item.desc}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-2.5 text-sm font-medium transition ${
              menuOpen ? "bg-primary text-white" : "bg-bitget/15 text-bitget hover:bg-bitget/25"
            }`}
          >
            <XianIcon name="list" size={15} className={menuOpen ? "text-white" : ""} />
            菜单
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
            placeholder="输入消息…"
            className="min-w-0 flex-1 rounded-2xl border border-bitget-border bg-bitget-panel py-2.5 px-4 text-[15px] outline-none placeholder:text-ink-faint focus:border-bitget/40"
          />
          <button
            type="button"
            className="btn-primary shrink-0 rounded-full px-4 py-2.5 text-sm"
            onClick={() => submit()}
            disabled={loading || !input.trim()}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
