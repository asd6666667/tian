import AgentLoopCard from "./AgentLoopCard";
import RunningStrategiesPanel from "./RunningStrategiesPanel";
import { strategyRunId } from "../utils/strategyRun";
import { formatOrderPrice, formatOrderQty, formatOrderSide } from "../utils/simActivity";
export default function PaperTradingPanel({
  session,

  simAccount,

  strategy,

  runningStrategies = [],

  focusedRunId,

  onSelectRunning,

  onStopRunning,

  running,

  onStart,

  onStop,

  onResume,

  market,

  openOrders = [],

  recentOrders = [],

  activityLogs = [],

  simStatus,

}) {

  if (!session) {

    return (

      <div className="panel p-6">

        <div className="animate-pulse space-y-3">

          <div className="h-5 w-48 rounded bg-bitget-border" />

          <div className="h-20 rounded bg-bitget-border/50" />

        </div>

        <p className="mt-4 text-xs text-ink-faint">正在连接模拟 API…若长时间无响应，请确认后端已启动</p>

      </div>

    );

  }



  const equity = simAccount?.accountEquity

    || session.holdings?.accountEquity

    || session.cash + (session.position || 0) * (market?.price || 0);

  const unrealised = Number(simAccount?.unrealisedPnl ?? session.holdings?.unrealisedPnl ?? 0);

  const spotAssets = simAccount?.configured

    ? (simAccount.spotAssets || [])

    : (session.holdings?.spot || []);

  const futuresPositions = simAccount?.configured

    ? (simAccount.futuresPositions || [])

    : (session.holdings?.futures || []);

  const cash = Number(simAccount?.usdt?.available ?? session.cash ?? 0);

  const spotTokenCount = spotAssets.filter((a) => Number(a.available) > 0 || Number(a.frozen) > 0).length;

  const futuresCount = futuresPositions.length;



  const orders = recentOrders.length ? recentOrders : (session.orders || []);

  const logs = activityLogs.length ? activityLogs : (session.logs || []);



  return (

    <div className="panel p-4">

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">

        <div>

          <h2 className="font-semibold">

            执行层 · {session.simApi ? "demo-bot 模拟API" : session.bitgetPaper ? "逆天 模拟盘" : "本地模拟"}

          </h2>

          <p className="text-xs text-ink-faint">
            {session.simApi
              ? "UTA V3 · 智能体：感知市场 → 融合策略决策 → 市价真实下单 · "
              : session.bitgetPaper
                ? "UTA V3 · "
                : ""}
            订单撮合 · 持仓同步 · 实时日志
          </p>
        </div>

        <div className="flex gap-2">

          {!running ? (

            <button className="btn-primary" onClick={onStart} disabled={!strategy || !simStatus?.configured}>

              {strategy
                ? runningStrategies.some((s) => strategyRunId(s) === strategyRunId(strategy))
                  ? `已运行 · ${strategy.name}`
                  : `加入模拟 · ${strategy.name}`
                : "启动模拟"}

            </button>

          ) : (

            <button className="btn-ghost border-loss/50 text-loss" onClick={onStop}>

              停止

            </button>

          )}

          {session.paused && (

            <button className="btn-ghost border-warn/35 text-warn" onClick={onResume}>

              解除暂停

            </button>

          )}

        </div>

      </div>



      {strategy && (
        <div className="mb-3 rounded-lg border border-bitget-border/80 bg-paper-sub/50 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs text-ink-faint">当前策略</div>
              <div className="text-sm font-medium text-ink">{strategy.name || "自定义策略"}</div>
            </div>
            {running && (
              <span className="rounded-full bg-profit/15 px-2 py-0.5 text-[10px] text-profit">
                运行中
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-ink-faint line-clamp-2">{strategy.summary}</div>
        </div>
      )}

      {!strategy && (
        <div className="mb-3 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-warn">
          请先在上方点击预设策略，或于对话中创建策略，再启动模拟
        </div>
      )}

      {!simStatus?.configured && (

        <div className="mb-3 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-warn">

          请先在上方「模拟账户 API」连接 Bitget 模拟盘 Key，再启动模拟

        </div>

      )}



      {simStatus?.configured && (
        <div className="mb-3 rounded-lg border border-bitget/30 bg-bitget/5 px-3 py-2 text-xs text-bitget">
          支持多策略并行 · 每 3 秒对各策略独立 tick · 共享同一模拟账户
        </div>
      )}

      {runningStrategies.length > 0 ? (
        <RunningStrategiesPanel
          runningStrategies={runningStrategies}
          selectedRunId={focusedRunId}
          onSelect={onSelectRunning}
          onRemove={onStopRunning}
          onStopAll={onStop}
        />
      ) : (
        <AgentLoopCard agent={session.lastAgentTick} running={running} />
      )}


      {openOrders.length > 0 && (

        <div className="mb-3 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-warn">

          {openOrders.length} 笔 Bitget 未成交挂单（demo-bot 规则：有挂单时跳过新单）

        </div>

      )}



      {session.paused && (

        <div className="mb-3 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">

          🛑 风控预警：交易已自动暂停，请检查回撤或调整策略参数

        </div>

      )}



      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">

        <div className="rounded-lg bg-paper-sub/70 p-3">

          <div className="text-xs text-ink-faint">账户权益</div>

          <div className="font-mono text-lg text-bitget">${equity.toFixed(2)}</div>

        </div>

        <div className="rounded-lg bg-paper-sub/70 p-3">

          <div className="text-xs text-ink-faint">可用现金</div>

          <div className="font-mono text-lg">${cash.toFixed(2)}</div>

        </div>

        <div className="rounded-lg bg-paper-sub/70 p-3">

          <div className="text-xs text-ink-faint">持仓</div>

          <div className="font-mono text-lg">

            现货 {spotTokenCount} · 合约 {futuresCount}

          </div>

        </div>

        <div className="rounded-lg bg-paper-sub/70 p-3">

          <div className="text-xs text-ink-faint">未实现盈亏</div>

          <div className={`font-mono text-lg ${unrealised >= 0 ? "text-profit" : "text-loss"}`}>

            {unrealised !== 0 ? `${unrealised >= 0 ? "+" : ""}$${unrealised.toFixed(2)}` : "—"}

          </div>

        </div>

      </div>





      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2 mt-4">

        <div>

          <h3 className="mb-2 text-xs font-medium uppercase text-ink-faint">最近订单</h3>

          <div className="max-h-[160px] overflow-y-auto rounded-lg border border-bitget-border">

            {orders.length === 0 ? (

              <div className="p-4 text-center text-xs text-ink-faint">暂无订单</div>

            ) : (

              orders.slice(0, 10).map((o) => (

                <div key={o.id || o.orderId} className="flex justify-between gap-2 border-b border-bitget-border/50 px-3 py-2 text-xs">

                  <span className={o.side === "buy" || o.posSide === "long" ? "text-profit" : "text-loss"}>

                    {formatOrderSide(o)} {o.symbol ? o.symbol.replace("USDT", "") : ""}{" "}

                    {formatOrderQty(o)}

                  </span>

                  <span className="font-mono">${formatOrderPrice(o)}</span>

                  <span className="text-ink-faint shrink-0">

                    {new Date(o.time).toLocaleTimeString("zh-CN")}

                  </span>

                </div>

              ))

            )}

          </div>

        </div>



        <div>

          <h3 className="mb-2 text-xs font-medium uppercase text-ink-faint">实时日志</h3>

          <div className="max-h-[160px] overflow-y-auto rounded-lg border border-bitget-border bg-paper-sub/50 p-2 font-mono text-xs">

            {logs.length === 0 ? (

              <div className="p-2 text-ink-faint">等待交易信号...</div>

            ) : (

              logs.slice(0, 15).map((log, i) => (

                <div

                  key={i}

                  className={`py-0.5 ${

                    log.level === "critical"

                      ? "text-loss"

                      : log.level === "warning"

                        ? "text-warn"

                        : "text-ink-muted"

                  }`}

                >

                  [{new Date(log.time).toLocaleTimeString("zh-CN")}] {log.message}

                </div>

              ))

            )}

          </div>

        </div>

      </div>



      {running && runningStrategies.length > 0 && (

        <div className="mt-3 flex items-center gap-2 text-xs text-profit">

          <span className="h-2 w-2 animate-pulse rounded-full bg-profit" />

          多策略运行中 · {runningStrategies.length} 个 · 每 3 秒并行 tick

        </div>

      )}

    </div>

  );

}

