import { useState, useEffect } from "react";
import { formatSimLogLine, futuresSideLabel, futuresSideClass, formatFuturesPrice, formatLiquidationPrice, formatOrderSide, formatOrderQty, formatOrderPrice } from "../utils/simActivity";
import AgentLoopCard from "./AgentLoopCard";
import PnLAnalysisPanel from "./PnLAnalysisPanel";
import { api } from "../api";

function CardShell({ title, children, footer }) {
  return (
    <div className="mt-1 overflow-hidden rounded-xl border border-bitget-border/80 bg-bitget-panel/90">
      {title && (
        <div className="border-b border-bitget-border/60 px-3 py-2 text-sm font-semibold text-ink">
          {title}
        </div>
      )}
      <div className="px-3 py-2.5">{children}</div>
      {footer && (
        <div className="border-t border-bitget-border/40 px-3 py-2 text-[11px] text-ink-faint">{footer}</div>
      )}
    </div>
  );
}

export function CancelCard({ content, results = [], symbol }) {
  const total = results.reduce((s, r) => s + (r.cancelled || r.results?.length || 0), 0);
  return (
    <CardShell title="撤单结果">
      <p className="text-sm text-ink-body">{content}</p>
      {results.length > 0 && (
        <div className="mt-2 space-y-1 text-xs text-ink-muted">
          {results.map((r) => (
            <div key={r.symbol}>
              {r.symbol}: 撤销 {r.cancelled ?? r.results?.length ?? 0} 笔
            </div>
          ))}
        </div>
      )}
      {symbol && !results.length && (
        <div className="mt-1 text-xs text-ink-faint">交易对 {symbol}</div>
      )}
      {total > 0 && (
        <div className="mt-2 text-xs text-profit">共撤销 {total} 笔</div>
      )}
    </CardShell>
  );
}

export function SimRequiredCard({ message }) {
  return (
    <CardShell title="需要连接模拟 API">
      <p className="text-sm text-warn">{message || "请先在页面上方配置 Bitget Demo Key 并连接模拟盘。"}</p>
      <p className="mt-2 text-xs text-ink-faint">
        配置路径：页面顶部「模拟 API 配置」→ 填入 Key → 连接。连接后可查资产、下单、撤单。
      </p>
    </CardShell>
  );
}

export function StatusCard({ status, content }) {
  return (
    <CardShell title="连接状态">
      <p className="text-sm text-ink-body">{content}</p>
      {status && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-ink-faint">模拟 API</span>
            <div className={status.simConfigured ? "text-profit" : "text-loss"}>
              {status.simConfigured ? "已配置" : "未配置"}
            </div>
          </div>
          <div>
            <span className="text-ink-faint">Bitget</span>
            <div className={status.bitget?.ok ? "text-profit" : "text-ink-muted"}>
              {status.bitget?.ok ? "已连接" : "未检测"}
            </div>
          </div>
        </div>
      )}
    </CardShell>
  );
}

export function HelpCard({ capabilities = [] }) {
  return (
    <CardShell title="可用功能">
      <ul className="space-y-1.5 text-[13px] text-ink-body">
        {capabilities.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </CardShell>
  );
}

export function AccountCard({ account }) {
  if (!account?.spotAssets?.length) {
    return (
      <CardShell title="账户资产">
        <p className="text-sm text-ink-muted">
          {account?.configured === false
            ? "模拟 API 未连接，无法读取资产。"
            : "暂无持仓数据。"}
        </p>
        {account?.accountEquity != null && (
          <div className="mt-2 text-xs text-ink-faint">
            账户权益 ${Number(account.accountEquity).toFixed(2)}
          </div>
        )}
      </CardShell>
    );
  }
  return (
    <CardShell title={`账户权益 $${Number(account.accountEquity || 0).toFixed(2)}`}>
      <div className="space-y-1 text-xs">
        {account.spotAssets.map((a) => (
          <div key={a.coin} className="flex justify-between border-b border-bitget-border/30 pb-1 last:border-0">
            <span className="text-ink-body">{a.coin}</span>
            <span className="font-mono text-ink-muted">{Number(a.available || 0).toFixed(6)}</span>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

export function OrdersCard({ orders: initialOrders = [], onCancelled }) {
  const [orders, setOrders] = useState(initialOrders);
  const [cancellingId, setCancellingId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setOrders(initialOrders);
  }, [initialOrders]);

  async function handleCancel(order) {
    if (!order?.orderId || cancellingId) return;
    setError(null);
    setCancellingId(order.orderId);
    try {
      await api.simCancel({ symbol: order.symbol, orderId: order.orderId });
      setOrders((prev) => prev.filter((o) => o.orderId !== order.orderId));
      onCancelled?.(order);
    } catch (e) {
      setError(e.message || "撤单失败");
    } finally {
      setCancellingId(null);
    }
  }

  if (!orders.length) {
    return (
      <CardShell>
        <p className="text-sm text-ink-muted">暂无未成交挂单</p>
      </CardShell>
    );
  }
  return (
    <CardShell title={`未成交挂单 (${orders.length})`}>
      <div className="space-y-2">
        {orders.map((o) => (
          <div
            key={o.orderId || `${o.symbol}-${o.side}-${o.price}`}
            className="flex items-center justify-between gap-2 rounded-lg border border-bitget-border/40 bg-paper-sub/40 px-2.5 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className={o.side === "buy" ? "text-profit" : "text-loss"}>
                {formatOrderSide(o)} {o.symbol}
                {o.orderType === "limit" && (
                  <span className="ml-1 text-ink-faint">限价</span>
                )}
              </div>
              <div className="mt-0.5 font-mono text-ink-body">
                {formatOrderQty(o)} @ {formatOrderPrice(o)}
              </div>
              {o.orderId && (
                <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                  #{o.orderId}
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={!!cancellingId}
              onClick={() => handleCancel(o)}
              className="shrink-0 rounded-md border border-loss/40 bg-loss/10 px-2.5 py-1.5 text-[11px] font-medium text-loss hover:bg-loss/20 disabled:opacity-50"
            >
              {cancellingId === o.orderId ? "撤单中…" : "撤单"}
            </button>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-loss">{error}</p>}
    </CardShell>
  );
}

export function FuturesCard({ positions = [] }) {
  if (!positions.length) {
    return (
      <CardShell>
        <p className="text-sm text-ink-muted">暂无合约持仓</p>
      </CardShell>
    );
  }
  return (
    <CardShell title="合约持仓">
      <div className="space-y-1.5 text-xs">
        {positions.map((p, i) => (
          <div key={p.symbol || i} className="border-b border-bitget-border/30 pb-1.5 last:border-0">
            <div className="flex justify-between gap-2">
              <span>{p.symbol} · {futuresSideLabel(p)}</span>
              <span className="font-mono">{p.total || p.size}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap justify-between gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
              <span>开仓 {formatFuturesPrice(p.openPrice ?? p.avgPrice)}</span>
              <span className="text-bitget">现价 {formatFuturesPrice(p.markPrice)}</span>
              <span>强平 {formatLiquidationPrice(p.liquidationPrice)}</span>
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

export function TradeCard({ trade, blocked }) {
  const p = trade?.perception?.composite;
  if (!trade?.symbol && !trade?.error && !trade?.reason) {
    return (
      <CardShell title={blocked ? "感知 Skill 拦截" : "交易结果"}>
        <p className="text-sm text-ink-muted">无交易详情</p>
      </CardShell>
    );
  }
  return (
    <CardShell title={blocked ? "感知 Skill 拦截" : "交易结果"}>
      <div className="space-y-1 text-[13px] text-ink-body">
        {trade?.symbol && (
          <div>
            {trade.category === "futures" ? (
              <>
                合约{trade.side === "close" ? "平仓" : trade.side === "long" ? "开多" : "开空"} {trade.symbol}
                {trade.leverage ? ` · ${trade.leverage}x` : ""}
              </>
            ) : (
              <>
                {trade.side === "buy" ? "买入" : "卖出"} {trade.symbol}
              </>
            )}
            {trade.qty != null && ` · ${Number(trade.qty).toFixed(6)}`}
            {trade.price != null && ` @ $${formatFuturesPrice(trade.price)}`}
            {trade.orderType && (
              <span className="text-ink-faint"> · {trade.orderType === "limit" ? "限价" : "市价"}</span>
            )}
          </div>
        )}
        {trade?.reason && <div className="text-ink-muted">{trade.reason}</div>}
        {trade?.position && trade.category === "futures" && trade.side !== "close" && (
          <div className="text-xs text-ink-faint">
            开仓价 {formatFuturesPrice(trade.position.openPrice ?? trade.position.avgPrice)}
            {" · "}
            强平价 {formatLiquidationPrice(trade.position.liquidationPrice)}
          </div>
        )}
        {trade?.usdtAmount != null && (
          <div className="text-xs text-ink-faint">花费约 {Number(trade.usdtAmount).toFixed(2)} USDT</div>
        )}
        {trade?.order?.orderId && (
          <div className="font-mono text-xs text-bitget">orderId {trade.order.orderId}</div>
        )}
        {trade?.pending && trade?.orderType === "limit" && (
          <div className="text-xs text-warn">⏳ 限价委托已提交，未成交前可在「我的挂单」查看</div>
        )}
        {p && (
          <div className="text-xs text-ink-faint">
            感知：{p.bias} ({p.score})
          </div>
        )}
      </div>
    </CardShell>
  );
}

export function MarketCard({ market, perception }) {
  const p = perception?.composite;
  return (
    <CardShell title={`${market?.symbol || ""} 行情`}>
      <div className="text-lg font-mono text-bitget">
        ${Number(market?.price || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </div>
      {p && (
        <div className="mt-1 text-xs text-ink-faint">
          感知 Skill：{p.bias} ({p.score})
        </div>
      )}
    </CardShell>
  );
}

function PnlSummaryRow({ label, pnl, pnlPct }) {
  const pos = Number(pnl) >= 0;
  return (
    <div className="rounded-lg border border-bitget-border/60 bg-paper-sub/40 px-3 py-2">
      <div className="text-[10px] text-ink-faint">{label}</div>
      <div className={`font-mono text-sm ${pos ? "text-profit" : "text-loss"}`}>
        {pnl >= 0 ? "+" : ""}
        {Number(pnl).toFixed(2)} USDT
      </div>
      {pnlPct != null && (
        <div className={`text-[10px] ${pos ? "text-profit" : "text-loss"}`}>
          {pnlPct >= 0 ? "+" : ""}
          {Number(pnlPct).toFixed(2)}%
        </div>
      )}
    </div>
  );
}

export function PnlCard({ pnl: initialPnl }) {
  const [pnl, setPnl] = useState(initialPnl);
  const [tab, setTab] = useState("spot");
  const days = initialPnl?.days || 30;
  const symbol = initialPnl?.symbol || "BTCUSDT";

  useEffect(() => {
    setPnl(initialPnl);
  }, [initialPnl]);

  useEffect(() => {
    if (!initialPnl?.configured) return undefined;
    let cancelled = false;
    const load = () =>
      api
        .simPnLAnalysis(days, symbol)
        .then((data) => {
          if (!cancelled && data?.configured) setPnl(data);
        })
        .catch(() => null);
    load();
    const t = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [days, symbol, initialPnl?.configured]);

  if (!pnl?.configured || !pnl?.spot) {
    return (
      <CardShell title="盈亏分析">
        <p className="text-sm text-ink-muted">
          {pnl?.message || "暂无盈亏数据，请先连接模拟 API 并完成几笔交易。"}
        </p>
      </CardShell>
    );
  }

  const summary = pnl.summary?.[tab] || pnl.summary?.spot;
  const active = tab === "futures" ? pnl.futures : pnl.spot;
  const updated = pnl.updatedAt
    ? new Date(pnl.updatedAt).toLocaleTimeString("zh-CN")
    : null;

  return (
    <div className="mt-1 space-y-3">
      <div className="overflow-hidden rounded-xl border border-bitget-border/80 bg-bitget-panel/90">
        <div className="flex items-center justify-between border-b border-bitget-border/60 px-3 py-2">
          <div className="flex gap-2">
            {[
              { id: "spot", label: "现货盈亏分析" },
              { id: "futures", label: "合约盈亏分析" },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded-full px-2.5 py-1 text-xs transition ${
                  tab === t.id
                    ? "bg-bitget/15 text-bitget font-medium"
                    : "text-ink-muted hover:text-ink-body"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-ink-faint">
            {pnl.source === "bitget-api" ? "Bitget 权益实时" : "本地快照"}
            {updated ? ` · ${updated}` : ""}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 px-3 py-3">
          <PnlSummaryRow label="今日盈亏" pnl={summary?.today?.pnl} pnlPct={summary?.today?.pnlPct} />
          <PnlSummaryRow label="7日盈亏" pnl={summary?.d7?.pnl} pnlPct={summary?.d7?.pnlPct} />
          <PnlSummaryRow label="30日盈亏" pnl={summary?.d30?.pnl} pnlPct={summary?.d30?.pnlPct} />
        </div>
        <div className="border-t border-bitget-border/40 px-3 py-2 text-xs text-ink-muted">
          {tab === "spot" ? (
            <>
              现货估值 <span className="font-mono text-ink">${Number(active.equity || 0).toFixed(2)}</span>
              {Math.abs(Number(active.unrealisedPnl || 0)) > 0.001 && (
                <span className="ml-2">
                  · 浮动{" "}
                  <span
                    className={`font-mono ${Number(active.unrealisedPnl) >= 0 ? "text-profit" : "text-loss"}`}
                  >
                    ${Number(active.unrealisedPnl || 0).toFixed(2)}
                  </span>
                </span>
              )}
              {active.tradeCount != null && (
                <span className="ml-2">· {active.tradeCount} 笔成交</span>
              )}
            </>
          ) : active.hasActivity ? (
            <>
              合约权益{" "}
              <span className="font-mono text-ink">${Number(active.equity || 0).toFixed(2)}</span>
              <span className="ml-2">
                · 保证金 ${Number(active.margin || 0).toFixed(2)}
              </span>
              <span className="ml-2">
                · 未实现{" "}
                <span className={`font-mono ${Number(active.unrealisedPnl) >= 0 ? "text-profit" : "text-loss"}`}>
                  ${Number(active.unrealisedPnl || 0).toFixed(2)}
                </span>
              </span>
              <span className="ml-2">
                · 盈亏{" "}
                <span className={`font-mono ${Number(active.totalPnl) >= 0 ? "text-profit" : "text-loss"}`}>
                  ${Number(active.totalPnl || 0).toFixed(2)}
                </span>
              </span>
            </>
          ) : (
            "暂无合约持仓"
          )}
        </div>
      </div>

      <PnLAnalysisPanel
        mode={tab}
        title={active.label || "盈亏分析"}
        equityCurve={active.equityCurve || []}
        assetEquityCurve={tab === "futures" ? active.accountEquityCurve : undefined}
        initialCapital={active.initialCapital}
        assetInitialCapital={tab === "futures" ? active.accountInitialCapital : active.initialCapital}
        currentEquity={tab === "spot" ? active.equity : active.totalPnl}
        assetCurrentEquity={tab === "futures" ? active.equity : active.equity}
        unrealisedPnl={active.unrealisedPnl ?? 0}
        metrics={{
          initialCapital: active.initialCapital,
          realizedPnl: active.realizedPnl,
        }}
        symbol={symbol.replace("USDT", "")}
        footnote={
          tab === "spot"
            ? "* 现货盈亏 = 现货权益变动（不含合约保证金/盈亏），每 8 秒刷新"
            : "* 合约盈亏 = 持仓盈亏（不含现货）；资产走势 = 保证金 + 未实现盈亏"
        }
        emptyMessage={tab === "futures" ? "暂无合约盈亏数据" : "暂无现货盈亏数据"}
      />
    </div>
  );
}

function tradeActionClass(action) {
  if (!action) return "text-ink-muted";
  if (/买入|开多|平空|BUY|LONG/i.test(action)) return "text-profit";
  if (/卖出|开空|平多|SELL|SHORT/i.test(action)) return "text-loss";
  return "text-ink-body";
}

function tradeStatusLabel(status) {
  if (status === "filled") return "成交";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "撤销";
  if (status === "pending") return "挂单";
  if (status === "skipped") return "跳过";
  return status || "—";
}

function tradeStatusClass(status) {
  if (status === "filled") return "text-profit";
  if (status === "failed") return "text-loss";
  if (status === "cancelled" || status === "skipped") return "text-ink-faint";
  return "text-ink-muted";
}

function formatTradeTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sourceLabel(source) {
  if (source === "bitget") return "Bitget";
  if (source === "bitget-history") return "Bitget";
  if (source === "agent" || source === "agent-log") return "Agent";
  if (source === "chat-agent") return "聊天";
  return "本地";
}

export function LogsCard({ entries: initialEntries = [], logs = [], meta: initialMeta }) {
  const [tab, setTab] = useState("all");
  const [entries, setEntries] = useState(initialEntries);
  const [meta, setMeta] = useState(initialMeta);

  useEffect(() => {
    setEntries(initialEntries);
    setMeta(initialMeta);
  }, [initialEntries, initialMeta]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .simLogs(50)
        .then((data) => {
          if (cancelled) return;
          if (data?.entries) setEntries(data.entries);
          if (data?.meta) setMeta(data.meta);
        })
        .catch(() => null);
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const displayEntries = (entries.length ? entries : logs.map((log) => ({
    id: log.order?.orderId || log.ts,
    action: formatOrderSide(log),
    symbol: log.symbol,
    qtyDisplay: log.qty || "—",
    priceDisplay: log.price ? String(log.price) : "—",
    orderId: log.order?.orderId,
    status: log.executed ? "filled" : log.error ? "failed" : "skipped",
    ts: log.ts,
    category: /FUTURES/i.test(String(log.category || "")) ? "futures" : "spot",
    source: log.source || "local",
    reason: formatSimLogLine(log),
    error: log.error || log.orderError,
  }))).filter((e) => {
    if (e.status === "skipped") return false;
    if (tab === "spot") return e.category === "spot";
    if (tab === "futures") return e.category === "futures";
    return true;
  });

  const updated = meta?.updatedAt
    ? new Date(meta.updatedAt).toLocaleTimeString("zh-CN")
    : null;

  return (
    <CardShell
      title="模拟交易日志"
      footer="* 仅展示成交 / 失败 / 挂单（不含策略观望跳过）· 合并 Bitget 历史订单 · 每 5 秒刷新"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {[
            { id: "all", label: "全部" },
            { id: "spot", label: "现货" },
            { id: "futures", label: "合约" },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                tab === t.id
                  ? "bg-bitget/15 text-bitget font-medium"
                  : "text-ink-muted hover:text-ink-body"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-ink-faint shrink-0">
          {meta?.source === "bitget-api" ? "Bitget 实时" : "本地记录"}
          {meta?.total != null && ` · ${meta.total} 笔`}
          {updated ? ` · ${updated}` : ""}
        </span>
      </div>

      {displayEntries.length === 0 ? (
        <p className="text-sm text-ink-muted">暂无交易记录，完成几笔模拟交易后将在此显示。</p>
      ) : (
        <div className="max-h-[280px] overflow-y-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-bitget-panel/95 text-ink-faint">
              <tr className="border-b border-bitget-border/50">
                <th className="pb-1.5 pr-2 font-normal">时间</th>
                <th className="pb-1.5 pr-2 font-normal">交易对</th>
                <th className="pb-1.5 pr-2 font-normal">方向</th>
                <th className="pb-1.5 pr-2 font-normal">数量</th>
                <th className="pb-1.5 pr-2 font-normal">价格</th>
                <th className="pb-1.5 pr-2 font-normal">单号</th>
                <th className="pb-1.5 font-normal">状态</th>
              </tr>
            </thead>
            <tbody>
              {displayEntries.map((e) => (
                <tr key={e.id} className="border-b border-bitget-border/30 align-top">
                  <td className="py-1.5 pr-2 text-ink-faint whitespace-nowrap">
                    {formatTradeTime(e.ts || e.time)}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-ink-body">{e.symbol || "—"}</td>
                  <td className={`py-1.5 pr-2 font-medium ${tradeActionClass(e.action)}`}>
                    {e.action || "—"}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-ink-muted">{e.qtyDisplay || "—"}</td>
                  <td className="py-1.5 pr-2 font-mono text-ink-muted">{e.priceDisplay || "—"}</td>
                  <td className="py-1.5 pr-2 font-mono text-[10px] text-ink-faint max-w-[72px] truncate" title={e.orderId || ""}>
                    {e.orderId ? e.orderId.slice(-8) : "—"}
                  </td>
                  <td className={`py-1.5 ${tradeStatusClass(e.status)}`}>
                    {tradeStatusLabel(e.status)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {displayEntries.some((e) => e.error || e.reason) && (
        <div className="mt-2 space-y-1 border-t border-bitget-border/40 pt-2 text-[10px] text-ink-faint">
          {displayEntries.slice(0, 5).map((e) => (
            <div key={`detail-${e.id}`} className="truncate" title={e.error || e.reason}>
              {e.orderId ? `[${String(e.orderId).slice(-6)}]` : ""}{" "}
              {sourceLabel(e.source)} · {e.error || e.reason}
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

export function TickCard({ tick, agent }) {
  const loopAgent = agent || tick?.agent;
  if (!tick && !loopAgent) return null;
  return (
    <div className="space-y-2">
      {loopAgent && <AgentLoopCard agent={loopAgent} running={false} />}
      {tick && (
        <CardShell title="策略执行">
          <div className="text-[13px] text-ink-body">
            <div>{tick.decision?.action?.toUpperCase() || "HOLD"} · {tick.decision?.reason}</div>
            {tick.executed && (
              <div className="mt-1 text-xs text-profit">
                已下单 {tick.order?.orderId ? `· ${tick.order.orderId}` : ""}
              </div>
            )}
            {tick.orderError && <div className="mt-1 text-xs text-loss">{tick.orderError}</div>}
          </div>
        </CardShell>
      )}
    </div>
  );
}

export function MultiTradeCard({ trades = [] }) {
  if (!trades.length) return null;
  return (
    <CardShell title="批量交易">
      <div className="space-y-2 text-xs">
        {trades.map((t, i) => (
          <div key={i} className="flex justify-between gap-2 border-b border-bitget-border/30 pb-1">
            <span className={t.ok ? "text-profit" : t.blocked ? "text-warn" : "text-loss"}>
              {t.symbol || "—"} {t.side}
            </span>
            <span className="text-right text-ink-muted">
              {t.ok ? `✅ ${Number(t.qty || 0).toFixed(6)}` : t.reason || t.error || "—"}
            </span>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

export function SymbolsCard({ symbols = [], total }) {
  return (
    <CardShell title={`可交易对 ${total ?? symbols.length}`}>
      <p className="mb-2 text-xs text-ink-faint">Bitget 模拟盘 USDT 现货（节选）</p>
      <div className="flex flex-wrap gap-1.5">
        {symbols.map((s) => (
          <span key={s} className="rounded bg-paper-sub/90 px-2 py-0.5 font-mono text-[10px] text-ink-body">
            {s.replace("USDT", "")}
          </span>
        ))}
      </div>
    </CardShell>
  );
}

const TYPE_LABEL = {
  sar_macd: "SAR+MACD",
  breakout_trend: "突破趋势",
  grid: "网格",
  trend: "趋势跟踪",
  custom: "自定义",
};

export function MyStrategiesCard({
  strategies = [],
  activeStrategy = null,
  runningStrategies = [],
  onSelect,
  onDelete,
}) {
  if (!strategies.length) {
    return (
      <CardShell title="我的策略">
        <p className="text-sm text-ink-muted">还没有保存的策略。</p>
        <p className="mt-2 text-xs text-ink-faint">
          在对话中描述策略、自主生成，或说「生成 BTC 策略」，系统会自动保存到这里。
        </p>
      </CardShell>
    );
  }

  const runningKeys = new Set(
    runningStrategies.map((s) => `${s.type || "custom"}_${s.symbol || ""}`)
  );
  const activeKey = activeStrategy
    ? `${activeStrategy.type || "custom"}_${activeStrategy.symbol || ""}`
    : null;

  return (
    <CardShell
      title={`我的策略 · ${strategies.length} 个`}
      footer="保存在本浏览器 · 点击切换 · 悬停可删除"
    >
      <div className="space-y-2">
        {strategies.map((s) => {
          const sym = (s.symbol || "BTCUSDT").replace(/USDT$/i, "");
          const key = `${s.type || "custom"}_${s.symbol || ""}`;
          const isActive = activeKey === key || activeStrategy?.id === s.id;
          const isRunning = runningKeys.has(key);
          return (
            <div key={s.id || key} className="group relative">
              <button
                type="button"
                onClick={() => onSelect?.(s)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                  isActive
                    ? "border-bitget bg-bitget/10 ring-1 ring-bitget/30"
                    : "border-bitget-border/70 bg-paper-sub/50 hover:border-bitget/40 hover:bg-bitget/5"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink-soft">{s.name || `${sym} 策略`}</span>
                  <span className="rounded bg-bitget/10 px-1.5 py-0.5 text-[10px] text-bitget">
                    {TYPE_LABEL[s.type] || s.type || "策略"}
                  </span>
                  <span className="font-mono text-[10px] text-ink-faint">{sym}</span>
                  {isActive && (
                    <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[10px] text-primary">当前</span>
                  )}
                  {isRunning && (
                    <span className="rounded bg-profit/12 px-1.5 py-0.5 text-[10px] text-profit">运行中</span>
                  )}
                </div>
                {(s.summary || s.rawInstruction) && (
                  <div className="mt-1 line-clamp-2 text-xs text-ink-faint">{s.summary || s.rawInstruction}</div>
                )}
              </button>
              {onDelete && s.isCustom !== false && (
                <button
                  type="button"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`删除策略「${s.name || sym}」？`))
                      onDelete(s.id, { symbol: s.symbol, type: s.type });
                  }}
                  className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full border border-bitget-border bg-bitget-panel text-[10px] text-ink-muted hover:border-loss/50 hover:text-loss group-hover:flex"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </CardShell>
  );
}

export function StrategyTradesCard({ trades: allTrades = [], summary = [], meta }) {
  const [selectedStrat, setSelectedStrat] = useState(summary.length > 0 ? summary[0]?.name : "all");

  const filtered = allTrades.filter((t) => {
    if (selectedStrat === "all") return true;
    const tName = t.strategyName || t.reason?.match(/策略[：:·]\s*(.+?)(?:\s*·|$)/)?.[1] || "未标记策略";
    return tName === selectedStrat;
  });

  const updated = meta?.updatedAt ? new Date(meta.updatedAt).toLocaleTimeString("zh-CN") : null;

  return (
    <CardShell title="策略交易记录">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedStrat("all")}
            className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
              selectedStrat === "all"
                ? "bg-bitget/15 text-bitget font-medium"
                : "text-ink-muted hover:text-ink-body"
            }`}
          >
            全部
          </button>
          {summary.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setSelectedStrat(s.name)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                selectedStrat === s.name
                  ? "bg-bitget/15 text-bitget font-medium"
                  : "text-ink-muted hover:text-ink-body"
              }`}
            >
              {s.name} ({s.count})
            </button>
          ))}
        </div>
        <span className="text-[10px] text-ink-faint shrink-0">
          {allTrades.length} 笔成交
          {updated ? ` · ${updated}` : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-ink-muted">暂无交易记录，完成几笔策略模拟交易后将在此显示。</p>
      ) : (
        <div className="max-h-[320px] overflow-y-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-bitget-panel/95 text-ink-faint">
              <tr className="border-b border-bitget-border/50">
                <th className="pb-1.5 pr-2 font-normal">时间</th>
                <th className="pb-1.5 pr-2 font-normal">交易对</th>
                <th className="pb-1.5 pr-2 font-normal">方向</th>
                <th className="pb-1.5 pr-2 font-normal">数量</th>
                <th className="pb-1.5 pr-2 font-normal">价格</th>
                <th className="pb-1.5 pr-2 font-normal">策略</th>
                <th className="pb-1.5 font-normal">单号</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const stratName = e.strategyName || e.reason?.match(/策略[：:·]\s*(.+?)(?:\s*·|$)/)?.[1] || "—";
                const side = /sell|平|卖出/i.test(String(e.side || e.reason || "")) ? "卖出" : "买入";
                return (
                  <tr key={e.id || i} className="border-b border-bitget-border/30 align-top">
                    <td className="py-1.5 pr-2 text-ink-faint whitespace-nowrap">
                      {formatTradeTime(e.ts || e.time)}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-ink-body">{e.symbol || "—"}</td>
                    <td className={`py-1.5 pr-2 font-medium ${side === "买入" ? "text-profit" : "text-loss"}`}>
                      {side}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-ink-muted">{e.qtyDisplay || "—"}</td>
                    <td className="py-1.5 pr-2 font-mono text-ink-muted">{e.priceDisplay || "—"}</td>
                    <td className="py-1.5 pr-2 text-ink-faint max-w-[80px] truncate">{stratName}</td>
                    <td className="py-1.5 font-mono text-[10px] text-ink-faint max-w-[72px] truncate" title={e.orderId || ""}>
                      {e.orderId ? e.orderId.slice(-8) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CardShell>
  );
}
