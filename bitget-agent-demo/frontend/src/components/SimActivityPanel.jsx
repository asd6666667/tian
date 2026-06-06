import { formatSimLogLine, formatOrderPrice, formatOrderQty, formatOrderSide } from "../utils/simActivity";



export default function SimActivityPanel({

  simStatus,

  strategy,

  account,

  openOrders = [],

  logs: externalLogs = [],

  recentOrders = [],

  loading = false,

  onRefresh,

}) {

  const symbol = strategy?.symbol || "BTCUSDT";

  const logs = externalLogs;

  const orders = openOrders;



  if (!simStatus?.configured) {

    return (

      <div className="panel p-4 text-sm text-ink-muted">

        <p className="mb-2">模拟 API 未连接</p>

        <p className="text-xs">请在上方「模拟账户 API」连接 Bitget 模拟盘 Key</p>

      </div>

    );

  }



  const spotCount = (account?.spotAssets || []).filter(

    (a) => Number(a.available) > 0 || Number(a.frozen) > 0

  ).length;

  const futuresCount = account?.futuresPositions?.length || 0;



  return (

    <div className="panel p-4">

      <div className="mb-3 flex items-center justify-between">

        <h3 className="font-semibold">逆天 模拟盘 · 实时同步</h3>

        <button className="btn-ghost text-xs" onClick={onRefresh} disabled={loading}>

          {loading ? "刷新中..." : "刷新"}

        </button>

      </div>



      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">

        <Stat

          label="账户权益"

          value={account?.accountEquity ? `$${Number(account.accountEquity).toFixed(2)}` : "—"}

          highlight

        />

        <Stat

          label="USDT 可用"

          value={account?.usdt?.available ? `$${Number(account.usdt.available).toFixed(2)}` : "—"}

        />

        <Stat label="现货代币" value={spotCount} sub={`合约 ${futuresCount}`} />

        <Stat label="未成交挂单" value={orders.length} />

      </div>




      {orders.length > 0 && (

        <div className="mb-4 mt-4">

          <h4 className="mb-2 text-xs uppercase text-ink-faint">未成交挂单</h4>

          <p className="mb-2 text-[10px] text-ink-faint">

            买单未成交前不会计入现货持仓；对应 USDT 会显示在「冻结」中

          </p>

          <div className="max-h-[120px] overflow-y-auto rounded border border-bitget-border text-xs">

            {orders.map((o) => (

              <div key={o.orderId} className="flex justify-between gap-2 border-b border-bitget-border/50 px-3 py-2">

                <span className={o.side === "buy" || o.posSide === "long" ? "text-profit" : "text-loss"}>

                  {formatOrderSide(o)} {o.symbol || symbol}

                </span>

                <span className="font-mono">{o.qty} @ {o.price}</span>

              </div>

            ))}

          </div>

        </div>

      )}



      {recentOrders.length > 0 && (

        <div className="mb-4 mt-4">

          <h4 className="mb-2 text-xs uppercase text-ink-faint">最近成交</h4>

          <div className="max-h-[120px] overflow-y-auto rounded border border-bitget-border text-xs">

            {recentOrders.slice(0, 8).map((o) => (

              <div key={o.id || o.orderId} className="flex justify-between gap-2 border-b border-bitget-border/50 px-3 py-2">

                <span className={o.side === "buy" || o.posSide === "long" ? "text-profit" : "text-loss"}>

                  {formatOrderSide(o)} {o.symbol || symbol}

                </span>

                <span className="font-mono">{formatOrderQty(o)} @ {formatOrderPrice(o)}</span>

              </div>

            ))}

          </div>

        </div>

      )}



      <h4 className="mb-2 mt-4 text-xs uppercase text-ink-faint">demo-bot 交易日志</h4>

      <div className="max-h-[200px] overflow-y-auto rounded border border-bitget-border bg-paper-sub/50 p-2 font-mono text-xs">

        {logs.length === 0 ? (

          <p className="text-ink-faint p-2">暂无日志 · 聊天下单或启动模拟后会同步</p>

        ) : (

          logs.map((log, i) => (

            <div key={i} className="border-b border-bitget-border/30 py-1.5">

              <span className="text-ink-faint">{log.ts?.slice(11, 19)}</span>

              {" "}

              <span className={log.executed ? "text-profit" : log.error ? "text-loss" : "text-ink-muted"}>

                {formatSimLogLine(log)}

              </span>

            </div>

          ))

        )}

      </div>

    </div>

  );

}



function Stat({ label, value, sub, highlight }) {

  return (

    <div className="rounded-lg bg-paper-sub/70 p-3">

      <div className="text-xs text-ink-faint">{label}</div>

      <div className={`font-mono text-sm ${highlight ? "text-bitget" : "text-ink-soft"}`}>{value}</div>

      {sub && <div className="mt-0.5 text-[10px] text-ink-faint">{sub}</div>}

    </div>

  );

}

