/**
 * 对话机器人路由 — Bitget 模拟盘 + 感知 Skill + 全资产交易
 */
import { gatherPerception } from "./perceptionSkills.js";
import { applyPerceptionGate, formatPerceptionLog } from "./perceptionGate.js";
import {
  getSimAccount,
  getSimAllOpenOrders,
  placeSimOrder,
  getSimTradeLogs,
  isSimApiConfigured,
  cancelAllAccountOrders,
} from "./simulationApi.js";
import { getAccountPnLAnalysis } from "./accountAnalysis.js";
import { getConnectionStatus } from "./bitgetClient.js";
import { recognizeStrategy, runAutonomousStrategyTick, generateAutonomousStrategy, runStrategyCheck } from "./agentHubStrategy.js";
import { buildParamRows } from "./intentParser.js";
import {
  executeChatOrderViaHub,
  isAgentHubReady,
} from "./agentHubBridge.js";
import {
  hubGetSimAccountView,
  hubGetFuturesPositions,
  hubCancelAllOrders,
} from "./hubAccountService.js";
import {
  resolveSymbolFromText,
  resolveSymbolFromTextSync,
  resolveAutonomousRoundSymbol,
  formatOrderQty,
  coinToSymbol,
  baseCoinFromSymbol,
} from "./symbolUtils.js";
import { getAssets, findAsset, getCurrentPositions, placeFuturesOrder, setFuturesLeverage } from "../../../demo-bot/bitget-v3.js";
import { handleChatLayer, isGreetingMessage } from "./deepseekChatAgent.js";
import { validateLimitPrice, defaultLimitPrice } from "./limitPriceGuard.js";
import { fetchBitgetSpotPrice, fetchBitgetFuturesPrice, formatLimitPriceError } from "./bitgetLivePrice.js";
import { isStrategyLeverageTweak, parseLeverageFromText } from "./intentParser.js";
import { isForceUserTrade, forceTradeSuffix } from "./forceTrade.js";

const BIAS_LABEL = { bullish: "偏多", bearish: "偏空", neutral: "中性" };
/** 解析限价价格：@ 3000、限价73500、73500限价
 *  u/usdt 后缀表示金额而非价格，不要误当价格
 */
function detectLimitPrice(text) {
  if (!text) return null;
  let m = text.match(/(?:@|价格)\s*(\d+(?:\.\d+)?)/i);
  if (m) return Number(m[1]);
  m = text.match(/限价\s*(\d+(?:\.\d+)?)/i);
  if (m) return Number(m[1]);
  m = text.match(/(\d+(?:\.\d+)?)\s*(?:限价|limit)/i);
  if (m) return Number(m[1]);
  return null;
}

function detectQty(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:个|枚|张)(?!\/)/i);
  return m ? Number(m[1]) : null;
}

/** 解析 USDT 金额：买入50u、50 USDT（优先匹配「买入/买」后的金额） */
function detectUsdtAmount(text) {
  if (!text) return null;
  let m = text.match(/(?:买入|买|花费|用)\s*(\d+(?:\.\d+)?)\s*(?:u|usdt|U(?![A-Z])|刀|美元)/i);
  if (m) return Number(m[1]);
  m = text.match(/(\d+(?:\.\d+)?)\s*(?:u|usdt|U(?![A-Z])|刀|美元)/i);
  if (m) {
    const limitPx = detectLimitPrice(text);
    const val = Number(m[1]);
    if (limitPx != null && val === limitPx && /(?:买入|买)/.test(text)) {
      const m2 = text.match(/(?:买入|买)[\s\S]*?(\d+(?:\.\d+)?)\s*(?:u|usdt)/i);
      if (m2) return Number(m2[1]);
    }
    if (limitPx != null && val === limitPx) return null;
    return val;
  }
  const m2 = text.match(/(\d+(?:\.\d+)?)\s*保证金/);
  return m2 ? Number(m2[1]) : null;
}

/** 策略管理类指令（非生成/设计） */
function isStrategyMetaCommand(text) {
  const t = (text || "").trim();
  if (isStrategyRunCommand(t)) return false;
  return (
    /^(?:启动|停止|查看|显示|当前|我的|帮助|菜单).{0,24}策略/.test(t) ||
    /策略.{0,10}(?:启动|停止|状态|帮助|列表|池)/.test(t)
  );
}

/** 自主一轮：生成策略 + 执行（不限 BTC，可自主选币） */
function isAutonomousRoundCommand(text) {
  const t = (text || "").trim();
  if (!t || /停止|暂停|关掉|取消/.test(t)) return false;
  if (/执行一轮|跑一轮|tick|模拟一轮/.test(t)) return true;
  if (/^执行策略$/.test(t)) return true;
  if (/^(?:立即|马上|现在|快)?(?:执行|运行|跑)\s*策略$/.test(t)) return true;
  return false;
}

/** 立即执行已有策略一轮（不重新生成） */
function isExistingStrategyRunCommand(text) {
  const t = (text || "").trim();
  if (!t || /停止|暂停|关掉|取消/.test(t)) return false;
  return (
    /^(?:执行|运行|跑).{0,12}(?:这个|该|一下|当前|我的)\s*策略/.test(t) ||
    (/^(?:立即|马上|现在|快)?(?:执行|运行|跑).{0,16}策略/.test(t) &&
      /这个|当前|我的|该/.test(t))
  );
}

/** @deprecated 用 isAutonomousRoundCommand / isExistingStrategyRunCommand */
function isStrategyRunCommand(text) {
  return isAutonomousRoundCommand(text) || isExistingStrategyRunCommand(text);
}

const TYPE_LABELS = {
  trend: "趋势跟踪",
  breakout_trend: "突破趋势",
  sar_macd: "SAR+MACD",
  grid: "网格交易",
};

function buildTickChatContent({
  strategy,
  agent,
  auto,
  strategyCheck,
  lastPrice,
  genThought,
  genConfidence,
  generatedFresh,
  autoStartPaper = false,
}) {
  const sym = strategy?.symbol || auto.tick?.symbol || "—";
  const coin = sym.replace(/USDT$/i, "");
  const typeLabel = TYPE_LABELS[strategy?.type] || strategy?.type || "策略";
  const priceLine = lastPrice > 0 ? ` · 现价 $${lastPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "";
  const checkLine = strategyCheck?.summary
    ? strategyCheck.entryReady
      ? `✅ 入场条件已满足：${strategyCheck.summary}`
      : `📋 条件校验：${strategyCheck.summary}`
    : null;

  if (!agent) {
    const lines = generatedFresh
      ? [
          `🧠 **自主生成并执行** · ${coin}${priceLine}`,
          genThought
            ? `💭 **策略思考**${genConfidence != null ? `（${(genConfidence * 100).toFixed(0)}%）` : ""}\n${genThought}`
            : null,
        ]
      : [`**${coin} · ${typeLabel}**${priceLine}`];
    return [
      ...lines,
      checkLine,
      auto.executed ? `已执行：${auto.decision?.reason || "—"}` : auto.decision?.reason || "本轮无操作",
      autoStartPaper
        ? "🚀 **说明**：将自动加入「运行中策略」每 3 秒继续 tick"
        : "💡 **说明**：策略已就绪，说「启动策略」开始自动运行",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const execLine = auto.executed
    ? `✅ 已成交 orderId ${agent.execute?.orderId || auto.order?.orderId || "—"}`
    : agent?.execute?.blockedByRisk
      ? `🛑 风控拦截：${agent.risk?.reason || auto.risk?.reason || "—"}`
      : agent?.execute?.error
        ? `❌ ${agent.execute.error}`
        : strategyCheck && !strategyCheck.entryReady
          ? `⏸ 未下单 · ${strategyCheck.summary}（须全部入场条件 + 置信≥75%）`
          : agent?.decide?.finalAction === "hold"
            ? `⏸ 未下单 · 决策观望${agent?.decide?.finalReason ? `（${agent.decide.finalReason}）` : ""}`
            : "⏸ 未下单 · 本轮无交易信号";
  const thought = agent.decide?.autonomousThought;
  const conf = agent.decide?.deepseekConfidence;
  const condLine =
    agent.decide?.conditionChecksTotal != null
      ? `条件 ${agent.decide.conditionChecksPassed}/${agent.decide.conditionChecksTotal} · `
      : "";

  const header = generatedFresh
    ? [
        `🧠 **自主生成并执行** · ${coin}${priceLine}`,
        genThought
          ? `💭 **策略思考**${genConfidence != null ? `（${(genConfidence * 100).toFixed(0)}%）` : ""}\n${genThought}`
          : null,
      ]
    : [`**${coin} · ${strategy?.name || typeLabel}**${priceLine}`];

  return [
    ...header,
    checkLine,
    thought ? `💭 **执行决策**（${condLine}置信 ${conf != null ? `${(conf * 100).toFixed(0)}%` : "—"}）\n${thought}` : null,
    `**1·感知** ${agent.perceive?.summary || "—"}`,
    `**2·决策** ${agent.decide?.finalReason || auto.decision?.reason || "—"}`,
    `**3·执行** ${execLine}`,
    `**4·风控** ${agent.risk?.reason || auto.risk?.reason || "—"}`,
    `**5·退出** ${agent.exit?.reason || "—"}`,
    autoStartPaper
      ? "🚀 **说明**：本轮链路已跑完；下方将自动加入「运行中策略」每 3 秒继续 tick，条件满足时再下单"
      : "💡 **说明**：策略已就绪，说「启动策略」开启自动运行",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function runAutonomousRound(text, previousStrategy) {
  const seedSym = await resolveAutonomousRoundSymbol(text, previousStrategy, getSimAccount);
  const hint = [
    text,
    "请根据实时感知自主选定最合适的 USDT 交易对（不限于 BTC），",
    "设计可执行的合约/现货策略参数，并完成本轮模拟盘决策。",
    seedSym ? `若未指定币种，可优先分析 ${baseCoinFromSymbol(seedSym)}，也可根据感知改选更优标的。` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const generated = await generateAutonomousStrategy({
    symbol: seedSym,
    hint,
    previousStrategy: null, // 自主思考：不参考旧策略，完全从零设计
  });

  const strat = {
    ...generated.strategy,
    paramRows: buildParamRows(generated.strategy, generated.strategy.rawInstruction || hint),
  };

  const auto = await runAutonomousStrategyTick(strat, {}, { cachedPerception: generated.perception });
  const tick = auto.tick;
  const agent = auto.agent;
  const strategyCheck = generated.strategyCheck || (await runStrategyCheck(strat));
  const lastPrice = Number(tick?.account?.lastPrice || 0);
  const perception = tick?.perceptionSnapshot || generated.perception || null;
  const autonomousThought =
    generated.autonomousThought || agent?.decide?.autonomousThought || null;

  const content = buildTickChatContent({
    strategy: strat,
    agent,
    auto,
    strategyCheck,
    lastPrice,
    genThought: generated.autonomousThought,
    genConfidence: generated.confidence,
    generatedFresh: true,
    autoStartPaper: false,
  });

  return {
    kind: "tick",
    content,
    tick,
    agent,
    strategy: strat,
    perception,
    strategyCheck,
    autonomousThought,
    generatedBy: "autonomous",
    autoStartPaper: false,
    market: lastPrice > 0 ? { symbol: strat.symbol, price: lastPrice } : null,
  };
}

/** 自主一轮 — SSE 阶段性推送（感知 → 生成 → 执行） */
export async function runAutonomousRoundStream(text, previousStrategy, emit) {
  if (!isSimApiConfigured()) {
    throw new Error("模拟 API 未连接。");
  }

  const send = (payload) => emit?.(payload);
  const heartbeat = setInterval(() => send({ phase: "ping", ts: Date.now() }), 12000);

  const waitProgress = (label, seconds, perception, buildTrace) => {
    let elapsed = 0;
    return setInterval(() => {
      elapsed += 8;
      send({
        phase: "progress",
        statusMessage: `${label}… 已 ${elapsed}s`,
        perception: perception || undefined,
        agent: buildTrace(`${label}… (${elapsed}s)`),
      });
    }, 8000);
  };

  try {
    const { buildWaitingAgentTrace, buildPerceptionStageTrace, buildPipelineAgentTrace } =
      await import("./tradingAgent.js");

    send({
      phase: "start",
      statusMessage: "正在解析交易对…",
      agent: buildWaitingAgentTrace("正在解析交易对…"),
    });

  const seedSym = await resolveAutonomousRoundSymbol(text, previousStrategy, getSimAccount);
  const coin = baseCoinFromSymbol(seedSym);

  send({
    phase: "perceive",
    statusMessage: `正在拉取 ${coin} 感知（Bitget/FRED/Finnhub）…`,
    symbol: seedSym,
    agent: buildWaitingAgentTrace(`正在感知 ${coin} 市场…`),
  });

  let perception;
  try {
    perception = await gatherPerception(seedSym, { force: true });
  } catch (e) {
    throw new Error(`感知失败：${e.message}`);
  }

  send({
    phase: "perceive_done",
    statusMessage: `${coin} 感知完成，开始 AI 策略设计…`,
    symbol: seedSym,
    perception,
    agent: buildPerceptionStageTrace(perception, `${coin} 感知完成 · 准备设计策略…`),
  });

  const hint = [
    text,
    "请根据实时感知自主选定最合适的 USDT 交易对（不限于 BTC），",
    "设计可执行的合约/现货策略参数，并完成本轮模拟盘决策。",
    seedSym ? `若未指定币种，可优先分析 ${coin}，也可根据感知改选更优标的。` : "",
  ]
    .filter(Boolean)
    .join(" ");

  send({
    phase: "generate",
    statusMessage: `正在自主设计 ${coin} 策略（约 20–60 秒）…`,
    perception,
    agent: buildPerceptionStageTrace(perception, `正在自主设计 ${coin} 策略…`),
  });

  const generateTimer = waitProgress(
    `正在自主设计 ${coin} 策略`,
    8,
    perception,
    (msg) => buildPerceptionStageTrace(perception, msg)
  );

  let generated;
  try {
    generated = await generateAutonomousStrategy({
      symbol: seedSym,
      hint,
      previousStrategy: null, // 自主思考：不参考旧策略，完全从零设计
      cachedPerception: perception,
    });
  } finally {
    clearInterval(generateTimer);
  }

  const strat = {
    ...generated.strategy,
    paramRows: buildParamRows(generated.strategy, generated.strategy.rawInstruction || hint),
  };

  send({
    phase: "strategy",
    statusMessage: `已生成「${strat.name || strat.type}」· 进入决策执行…`,
    strategy: strat,
    strategyCheck: generated.strategyCheck,
    perception: generated.perception,
    autonomousThought: generated.autonomousThought,
    agent: buildPipelineAgentTrace({
      perception: generated.perception,
      decide: {
        strategyAction: "hold",
        finalAction: "hold",
        finalReason: `已生成「${strat.name || strat.type}」· ${strat.symbol}`,
        autonomousThought: generated.autonomousThought,
        deepseekConfidence: generated.confidence,
        deepseekUsed: true,
      },
      risk: { ok: true, reason: "策略已就绪，准备执行…" },
    }),
  });

  send({
    phase: "execute",
    statusMessage: "决策 · 风控 · 执行中（约 30–90 秒）…",
    perception: generated.perception,
    agent: buildPipelineAgentTrace({
      perception: generated.perception,
      decide: {
        strategyAction: "hold",
        finalAction: "hold",
        finalReason: "正在决策与执行…",
        autonomousThought: generated.autonomousThought,
        deepseekConfidence: generated.confidence,
        deepseekUsed: true,
      },
      risk: { ok: true, reason: "风控校验中…" },
    }),
  });

  const execTimer = waitProgress(
    "决策·风控·执行",
    8,
    generated.perception,
    (msg) =>
      buildPipelineAgentTrace({
        perception: generated.perception,
        decide: {
          finalAction: "hold",
          finalReason: msg,
          autonomousThought: generated.autonomousThought,
          deepseekUsed: true,
        },
        risk: { ok: true, reason: "风控校验中…" },
      })
  );

  let auto;
  try {
    auto = await runAutonomousStrategyTick(strat, {}, { cachedPerception: generated.perception });
  } finally {
    clearInterval(execTimer);
  }
  const tick = auto.tick;
  const agent = auto.agent;
  const strategyCheck = generated.strategyCheck || (await runStrategyCheck(strat));
  const lastPrice = Number(tick?.account?.lastPrice || 0);
  perception = tick?.perceptionSnapshot || generated.perception || perception;
  const autonomousThought =
    generated.autonomousThought || agent?.decide?.autonomousThought || null;

  const content = buildTickChatContent({
    strategy: strat,
    agent,
    auto,
    strategyCheck,
    lastPrice,
    genThought: generated.autonomousThought,
    genConfidence: generated.confidence,
    generatedFresh: true,
    autoStartPaper: false,
  });

  const result = {
    kind: "tick",
    content,
    tick,
    agent,
    strategy: strat,
    perception,
    strategyCheck,
    autonomousThought,
    generatedBy: "autonomous",
    autoStartPaper: false,
    market: lastPrice > 0 ? { symbol: strat.symbol, price: lastPrice } : null,
  };

  const slimAgent = slimAgentTrace(agent);
  send({ phase: "agent", agent: slimAgent });

  const slimResult = slimAutonomousRoundResult(result);
  send({
    phase: "complete",
    ...slimResult,
  });
  return result;
  } finally {
    clearInterval(heartbeat);
  }
}

export { isAutonomousRoundCommand, isExistingStrategyRunCommand };

/** 用户希望 Agent 自主思考并设计策略（非粘贴规则条文） */
function isAutonomousStrategyCommand(text) {
  const t = (text || "").trim();
  if (!t || isStrategyMetaCommand(t)) return false;

  const isGenerateCmd =
    /自主.*策略|自动.*生成.*策略|智能.*策略|AI.*策略/i.test(t) ||
    /帮我设计|帮我生成|帮我想|思考.*策略|设计(?:一个|个)?.*策略/i.test(t) ||
    /^生成\s*\w*\s*策略/.test(t) ||
    /^(?:给|为)\s*\w+\s*(?:设计|生成).*策略/.test(t) ||
    /(?:想|来|搞|弄|写|推荐|给我|想要|需要).{0,28}策略/.test(t) ||
    /策略.{0,16}(?:方案|思路|设计|推荐)/.test(t);

  if (!isGenerateCmd) return false;

  // 长文规则描述 → 走策略解析（用户粘贴完整规则）
  if (t.length >= 60 && /止损|入场|开仓条件|离场|风控|核心逻辑/.test(t)) return false;
  if (/止损/.test(t) && /止盈/.test(t) && /(?:仓位|买入|突破|均线|成交量)/.test(t)) return false;
  if (
    t.length >= 40 &&
    [/止损/, /止盈/, /仓位/, /突破/, /均线/, /成交量/].filter((re) => re.test(t)).length >= 2
  ) {
    return false;
  }
  return true;
}

/** 是否为策略说明/规则描述（非即时交易指令） */
function isStrategyDescription(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (isAutonomousStrategyCommand(t) || isStrategyMetaCommand(t)) return false;

  const ruleSignals = [
    /入场条件/,
    /离场条件/,
    /出场条件/,
    /开仓条件/,
    /平仓条件/,
    /核心逻辑/,
    /建仓原则/,
    /仓位管理/,
    /全局风控/,
    /条件\s*[1-9①②③④⑤]/,
    /止损[\s\S]{0,120}止盈|止盈[\s\S]{0,120}止损/,
    /[一二三四五六七八九十]+[、.．]\s*\S{2,20}/,
    /交易对.*周期|周期.*[Kk]?线/,
    /(?:做多|做空)[\s\S]{0,40}条件/,
    /移动止损|追踪止损|跟踪止损/,
    /盈亏比|r\s*[:：]|:\s*1\s*[:：]\s*2/i,
    /连续.*(?:亏损|止损).*(?:后|则)/,
    /禁止.*(?:加仓|补仓|手动)/,
    /(?:MA|EMA|SMA|均线)\s*\d+/i,
    /(?:USDT|U本位|USD).*(?:永续|合约)/i,
    /突破.*(?:高|低)点|成交量.*(?:放大|倍数)/,
  ];
  if (ruleSignals.some((re) => re.test(t))) return true;

  const ruleKeywords = [
    /止损/,
    /止盈/,
    /开仓/,
    /平仓/,
    /入场/,
    /风控/,
    /仓位/,
    /杠杆/,
    /K线/,
    /均线/,
    /突破/,
    /成交量/,
    /永续/,
    /合约/,
  ];
  const hit = ruleKeywords.filter((re) => re.test(t)).length;
  if (t.length >= 60 && hit >= 3) return true;

  if (t.length > 100 && /SAR|MACD|RSI|均线|布林|K线/.test(t) && /止损|止盈|条件|信号/.test(t)) {
    return true;
  }
  return false;
}

function isFuturesCommand(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (isStrategyDescription(t)) return false;
  if (/怎么|如何|什么是|介绍/.test(t)) return false;
  if (/合约持仓|查看合约|我的合约/.test(t) && !/开|平|买|卖|多|空|杠杆/.test(t)) return false;
  if (/强制(?:开多|开空|开仓|平多|平空|平仓|清仓)/.test(t)) return true;
  if (isForceUserTrade(t) && /(?:开|平|多|空|仓|保证金|杠杆|永续)/i.test(t)) return true;
  // 短句直接下单
  if (t.length <= 80 && /^(?:强制)?(开多|开空|平多|平空|平仓|做多|做空|开仓)/.test(t)) return true;
  return (
    /平仓|平多|平空/.test(t) ||
    /开多|开空/.test(t) ||
    (/杠杆|逐仓|全仓|保证金|永续/.test(t) && /开|平|多|空/.test(t)) ||
    (/\d+\s*[xX×倍]/.test(t) && /多|空|long|short/i.test(t)) ||
    (/市价单|市价|限价/.test(t) && /多|空|long|short/i.test(t) && !/条件|满足|当/.test(t))
  );
}

function resolveFuturesCloseSide(text, positions, sym) {
  const t = text || "";
  if (/平空|平.*空/.test(t) && !/平多/.test(t)) return "short";
  if (/平多/.test(t)) return "long";

  const symPos = (positions || []).filter(
    (p) => (p.symbol || "").toUpperCase() === sym.toUpperCase()
  );
  const open = symPos.filter((p) => Number(p.total || p.size || p.available || 0) > 0);
  if (open.length === 1) {
    return String(open[0].holdSide || open[0].posSide || "long").toLowerCase();
  }
  if (open.length > 1) return null;
  return "long";
}

function parseFuturesIntent(text) {
  const t = text || "";
  const isClose = /平仓|平多|平空|close/i.test(t);
  const isShort =
    !isClose &&
    (/空|short|开空|做空|空单/.test(t) && !/多|long|开多|做多/.test(t));
  const side = isClose ? "close" : isShort ? "short" : "long";
  const leverageMatch = t.match(/(\d+)\s*[xX×倍]/);
  const leverage = leverageMatch ? Number(leverageMatch[1]) : null; // null = 由执行层决定
  const marginUsdt = detectUsdtAmount(t);
  const marginMode = /逐仓|isolated/i.test(t) ? "isolated" : "crossed";
  const orderType = /限价|limit/i.test(t) ? "limit" : "market";
  return {
    side,
    leverage,
    marginUsdt,
    marginMode,
    orderType,
    price: detectLimitPrice(t),
    isClose,
  };
}

function isCloseAllPositions(text) {
  return /(?:强制)?平掉全部|强制全部平仓|全部强制平仓|全部平仓|一键平仓|平掉所有仓位|关闭全部仓位|平掉全部仓位|全部平掉|清空全部仓位/.test(
    String(text || "")
  );
}

function isScanCommand(text) {
  const t = (text || "").trim();
  if (/信号扫描|感知\s*skill|全面分析|市场分析/.test(t)) return true;
  if (/突破|网格|套利|买入|仓位|止盈|止损|策略/.test(t)) return false;
  if (/^扫描/.test(t)) return true;
  return false;
}

export function detectChatIntent(text, previousStrategy) {
  const t = (text || "").trim();

  // 创意/生成类策略请求 → 自主思考（DeepSeek Premium）
  if (isAutonomousStrategyCommand(t)) {
    return { type: "autonomous_strategy" };
  }

  if (isStrategyDescription(t)) {
    return { type: "strategy" };
  }

  if (isExistingStrategyRunCommand(t)) {
    return { type: "tick" };
  }

  if (isStrategyLeverageTweak(t, previousStrategy)) {
    return { type: "strategy" };
  }

  if (isScanCommand(t)) {
    return { type: "scan" };
  }
  if (
    /^(余额|资产|账户|我的钱|权益|持仓情况|我的资产)/.test(t) ||
    (/余额|资产明细|账户权益|我的资产|查看资产/.test(t) && !/买|卖|策略/.test(t))
  ) {
    return { type: "account" };
  }
  if (/可交易|交易对列表|支持哪些币/.test(t)) return { type: "symbols" };
  if (/挂单|未成交|委托单|我的订单/.test(t)) return { type: "orders" };
  if (/合约持仓|合约仓位|期货持仓/.test(t) && !isFuturesCommand(t)) return { type: "futures" };
  if (isFuturesCommand(t)) {
    return { type: "futures_trade", ...parseFuturesIntent(t) };
  }
  if (/撤单|取消.*单|撤销.*单|全部撤单/.test(t)) {
    return { type: "cancel", all: /全部|所有/.test(t) };
  }
  if (isCloseAllPositions(t)) {
    return { type: "close_all_positions" };
  }
  if (/现价|价格|行情|多少钱/.test(t) && !/策略/.test(t)) return { type: "market" };
  if (/盈亏|pnl|收益分析|账户报告/.test(t) && !/止损|止盈|入场|开仓条件|风控规则/.test(t)) {
    return { type: "pnl" };
  }
  if (/模拟交易日志|交易日志|最近交易|成交记录/.test(t)) return { type: "logs" };
  if (/策略.*记录|策略.*开单|策略.*交易|开单记录|交易记录|我的策略.*下单/.test(t)) return { type: "strategy_trades" };
  if (/连接状态|api状态|是否连接/.test(t)) return { type: "status" };
  if (/帮助|你能做什么|功能|菜单/.test(t)) return { type: "help" };
  if (/当前策略/.test(t)) return { type: "show_strategy" };
  if (/换成|改为|应用到|切换.*策略.*到/.test(t) && detectMentionedSymbol(t)) {
    return { type: "strategy_resymbol" };
  }

  if (isGreetingMessage(t)) return { type: "chat" };

  return { type: "chat" };
}

function detectMentionedSymbol(text) {
  return resolveSymbolFromTextSync(text, null);
}

function perceptionLine(perception) {
  if (!perception?.composite) return "";
  const { bias, score } = perception.composite;
  return `感知 Skill：${BIAS_LABEL[bias] || bias} (${score}) · ${formatPerceptionLog({ bias, score, signalCount: perception.composite.signals?.length || 0 })}`;
}

function flashSummaryLine(perception) {
  const ds = perception?.deepseekPerception;
  if (!ds?.summary) return "";
  return `\n🧠 感知：${ds.summary}`;
}

async function buildScanResult(sym, { forcePerception = true } = {}) {
  let perception = null;
  let price = null;
  try {
    perception = await gatherPerception(sym, { force: forcePerception });
  } catch (e) {
    console.warn("[scan] perception failed:", e.message);
  }
  try {
    const live = await fetchBitgetSpotPrice(sym);
    price = live.lastPrice;
  } catch { /* ignore */ }
  const base = baseCoinFromSymbol(sym);
  return {
    kind: "scan",
    content: perception
      ? `已完成 ${base} 的 5 大感知 Skill 扫描${flashSummaryLine(perception) || "："}`
      : `已获取 ${base} 行情${price ? ` $${price}` : ""}，感知 Skill 暂不可用。`,
    perception,
    market: { symbol: sym, price },
    symbol: sym,
  };
}

async function buildAutonomousStrategyResult(text, previousStrategy) {
  const sym = await resolveSymbolFromText(text, previousStrategy?.symbol || "BTCUSDT");
  const generated = await generateAutonomousStrategy({
    symbol: sym,
    hint: text,
    previousStrategy,
  });
  const { strategy, strategyCheck, perception, autonomousThought, marketView, confidence } = generated;

  let market = null;
  try {
    const live = await fetchBitgetSpotPrice(strategy.symbol);
    const price = live.lastPrice;
    if (price) market = { symbol: strategy.symbol, price, source: "bitget-api" };
  } catch { /* ignore */ }

  const simReady = isSimApiConfigured();
  const base = baseCoinFromSymbol(strategy.symbol);
  const lines = [
    `已自主分析 ${base} 市场并生成策略 👇`,
    autonomousThought ? `💭 思考：${autonomousThought}` : null,
    marketView ? `📌 观点：${marketView}` : null,
    confidence != null ? `置信 ${(confidence * 100).toFixed(0)}%` : null,
    strategyCheck?.entryReady
      ? simReady
        ? "✅ 入场条件已满足 · 策略已就绪，说「启动策略」开始执行。"
        : "✅ 入场条件已满足 · 连接 API 后说「启动策略」开始执行。"
      : strategyCheck?.summary
        ? `📋 条件校验：${strategyCheck.summary}`
        : "策略已生成，说「启动策略」开始执行。",
    simReady ? "✅ 已保存到「我的策略」，说「启动策略」运行。" : "ℹ️ 连接模拟 API 后说「启动策略」运行。",
  ].filter(Boolean);

  if (perception?.deepseekPerception?.summary) {
    lines.push(`感知：${perception.deepseekPerception.summary}`);
  }

  return {
    kind: "strategy",
    content: lines.join("\n"),
    strategy,
    perception,
    market,
    symbol: strategy.symbol,
    strategyCheck,
    autonomousThought,
    autoStartPaper: false,
    generatedBy: "autonomous",
  };
}

async function buildAutonomousStrategyResultSafe(text, previousStrategy) {
  try {
    return await buildAutonomousStrategyResult(text, previousStrategy);
  } catch (e) {
    console.warn("[chatAgent] 自主策略生成失败，回退规则解析:", e.message);
    const fallback = await buildStrategyUpdateResult(text, previousStrategy);
    return {
      ...fallback,
      content: `AI 自主分析暂不可用（${e.message}），已用规则引擎解析策略 👇\n${fallback.content}`,
    };
  }
}

async function buildStrategyUpdateResult(text, previousStrategy) {
  const { strategy, strategyCheck, perception } = await recognizeStrategy(text, previousStrategy);
  let market = null;

  try {
    const live = await fetchBitgetSpotPrice(strategy.symbol);
    const price = live.lastPrice;
    if (price) market = { symbol: strategy.symbol, price, source: "bitget-api" };
  } catch { /* ignore */ }

  const simReady = isSimApiConfigured();
  const levChanged = strategy.leverageTweak || parseLeverageFromText(text, null) != null;
  const lines = [
    levChanged && strategy.category !== "spot"
      ? `⚡ 杠杆已调整为 ${strategy.leverage}x · 已更新 ${baseCoinFromSymbol(strategy.symbol)} 策略 👇`
      : `收到，已为你更新 ${baseCoinFromSymbol(strategy.symbol)} 策略 👇`,
    strategy.type === "sar_macd"
      ? strategyCheck?.entryReady
        ? simReady
          ? "✅ SAR+MACD 三项入场条件均已满足 · 策略已就绪，说「启动策略」开始执行。"
          : "✅ SAR+MACD 三项入场条件均已满足 · 连接模拟 API 后说「启动策略」开始执行。"
        : `📋 SAR+MACD 条件校验：${strategyCheck?.summary || "分析中…"}${simReady ? " · 已加入策略池" : ""}`
      : strategy.type === "breakout_trend"
        ? strategyCheck?.entryReady
          ? simReady
            ? `✅ 突破条件已满足（${strategyCheck.summary}）· 策略已就绪，说「启动策略」开始执行。`
            : `✅ 突破条件已满足 · 连接 API 后说「启动策略」开始执行。`
          : `📋 突破趋势校验：${strategyCheck?.summary || strategy.summary || "分析中…"}${simReady ? " · 策略已就绪" : " · 已保存到「我的策略」"}`
        : simReady
          ? levChanged
            ? `✅ 参数已保存到「我的策略」${strategy.leverage ? ` · 当前 ${strategy.leverage}x` : ""}`
            : "策略已就绪，说「启动策略」开始执行。已保存到「我的策略」。"
          : "ℹ️ 策略已保存到「我的策略」。连接模拟 API 后，对 Agent 说策略会自动加入策略池。",
  ];
  if (perception?.deepseekPerception?.summary) {
    lines.push(`🧠 感知：${perception.deepseekPerception.summary}`);
  } else if (perception) {
    lines.push(perceptionLine(perception));
  }
  if (strategy.symbolNote) lines.push(`⚠️ ${strategy.symbolNote}`);
  return {
    kind: "strategy",
    content: lines.join("\n"),
    strategy,
    perception,
    market,
    symbol: strategy.symbol,
    strategyCheck,
    autoStartPaper: false,
  };
}

async function executeFuturesTrade({ text, symbol, intent, strategy }) {
  if (!isSimApiConfigured()) {
    return { ok: false, error: "模拟 API 未连接，请先在上方配置 Bitget Demo Key" };
  }

  const sym = symbol || "BTCUSDT";
  const baseCoin = baseCoinFromSymbol(sym);
  const { side, leverage: rawLeverage, marginUsdt, marginMode, orderType, price, isClose } = intent;

  // 杠杆智能决定：用户指定 > 策略杠杆 > BTC 默认 3x > 其他 2x
  const finalLeverage = rawLeverage
    ?? strategy?.leverage
    ?? (sym.includes("BTC") ? 3 : 2);

  try {
    const live = await fetchBitgetFuturesPrice(sym);
    const lastPrice = live.lastPrice;

    if (!isClose) {
      await setFuturesLeverage(sym, finalLeverage);
    }

    if (orderType === "limit" && !price) {
      return { ok: false, error: "合约限价单请指定价格，如「限价平多 BTC @ 73000」" };
    }

    if (orderType === "limit" && price) {
      const check = validateLimitPrice(price, lastPrice);
      if (!check.ok) {
        return { ok: false, error: formatLimitPriceError(check, sym, lastPrice) };
      }
    }

    let qty;
    let reduceOnly = "NO";
    let posSide = side === "short" ? "short" : "long";
    let orderSide = posSide;

    if (isClose) {
      const positions = await getCurrentPositions("USDT-FUTURES");
      const closeSide = resolveFuturesCloseSide(text, positions, sym);
      if (!closeSide) {
        return {
          ok: false,
          error: `${sym} 同时有多/空持仓，请指定「平多」或「平空」`,
        };
      }
      posSide = closeSide;
      const pos = positions.find(
        (p) =>
          (p.symbol || "").toUpperCase() === sym.toUpperCase() &&
          String(p.holdSide || p.posSide || "").toLowerCase() === closeSide
      );
      qty = Number(pos?.total || pos?.size || pos?.available || 0);
      if (qty <= 0) {
        return { ok: false, error: `${sym} 暂无 ${closeSide === "long" ? "多" : "空"}单可平` };
      }
      reduceOnly = "YES";
      orderSide = closeSide === "long" ? "sell" : "buy";
    } else {
      const margin = marginUsdt ?? 50;
      if (margin < 5) {
        return { ok: false, error: "合约保证金至少约 5 USDT，请指定如「100u保证金」" };
      }
      const notional = margin * finalLeverage;
      qty = notional / lastPrice;
      if (qty <= 0) {
        return { ok: false, error: "计算合约数量失败，请检查保证金与价格" };
      }
    }

    const qtyStr = qty >= 1 ? qty.toFixed(4) : qty.toFixed(6);

    const order = await placeFuturesOrder({
      symbol: sym,
      side: orderSide,
      posSide,
      orderType,
      qty: qtyStr,
      price: orderType === "limit" ? price : undefined,
      reduceOnly,
    });

    const marginNote =
      marginMode === "isolated"
        ? "（模拟 UTA 仅支持全仓，已按全仓提交）"
        : "";

    const typeLabel = orderType === "limit" ? "限价" : "市价";
    const priceLabel =
      orderType === "limit" && price ? ` @ ${price}` : ` @ $${lastPrice.toFixed(2)}`;

    const reason = isClose
      ? `合约${typeLabel}平仓 ${baseCoin} ${posSide}${priceLabel}${forceTradeSuffix(text)}`
      : `合约${typeLabel}${posSide === "long" ? "开多" : "开空"} ${baseCoin} · ${finalLeverage}x · 保证金约 ${marginUsdt ?? "?"} USDT${priceLabel}${marginNote}${forceTradeSuffix(text)}`;

    const logPrice = orderType === "limit" && price ? price : lastPrice;

    try {
      const { appendSimTradeLog } = await import("./simulationApi.js");
      appendSimTradeLog({
        ts: new Date().toISOString(),
        source: "chat-agent",
        category: "USDT-FUTURES",
        symbol: sym,
        side: isClose ? "close" : posSide,
        posSide,
        qty: qtyStr,
        price: logPrice,
        orderType,
        leverage: finalLeverage,
        marginUsdt: marginUsdt ?? null,
        order,
        executed: true,
        decision: { action: isClose ? "close" : posSide, reason },
      });
      const assets = await getAssets();
      const positions = await getCurrentPositions("USDT-FUTURES");
      const { recordEquitySnapshot } = await import("./accountAnalysis.js");
      recordEquitySnapshot(assets, "all", positions);
    } catch {
      /* ignore log errors */
    }

    let position = null;
    if (!isClose) {
      try {
        const positions = await getCurrentPositions("USDT-FUTURES");
        const { normalizeFuturesPositions } = await import("./futuresUtils.js");
        position =
          normalizeFuturesPositions(positions).find(
            (p) =>
              (p.symbol || "").toUpperCase() === sym.toUpperCase() &&
              String(p.posSide || p.holdSide || "").toLowerCase() === posSide
          ) || null;
      } catch {
        /* ignore */
      }
    }

    return {
      ok: true,
      category: "futures",
      side: isClose ? "close" : posSide,
      symbol: sym,
      qty,
      price: logPrice,
      orderType,
      leverage: finalLeverage,
      marginUsdt: marginUsdt ?? null,
      order,
      reason,
      position,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function executeCloseAllFutures() {
  const { closeAllFuturesPositions, getCurrentPositions, placeFuturesOrder } = await import(
    "../../../demo-bot/bitget-v3.js"
  );
  const { normalizeFuturesPositions } = await import("./futuresUtils.js");

  let positions = [];
  try {
    positions = normalizeFuturesPositions(await getCurrentPositions("USDT-FUTURES"));
  } catch {
    /* ignore */
  }

  const open = positions.filter((p) => Number(p.total || p.size || 0) > 0);
  if (!open.length) {
    return { ok: true, skipped: true, count: 0, results: [] };
  }

  try {
    const data = await closeAllFuturesPositions();
    const list = Array.isArray(data?.list) ? data.list : [];
    const results = open.map((p, i) => ({
      ok: true,
      category: "futures",
      symbol: p.symbol,
      side: "close",
      posSide: p.holdSide,
      qty: p.total || p.size,
      order: list[i] || data,
    }));
    // 写入模拟交易日志
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const pos = open[i];
      try {
        const { appendSimTradeLog } = await import("./simulationApi.js");
        appendSimTradeLog({
          ts: new Date().toISOString(),
          source: "chat-agent",
          category: "USDT-FUTURES",
          symbol: r.symbol,
          side: "close",
          posSide: r.posSide,
          qty: String(r.qty),
          price: Number(pos.markPrice || 0),
          orderType: "market",
          order: r.order,
          executed: true,
          decision: { action: "close", reason: `批量平仓 ${r.symbol} ${r.posSide}` },
        });
      } catch { /* ignore log errors */ }
    }
    return {
      ok: true,
      method: "bulk",
      count: open.length,
      results,
      closedSymbols: open.map((p) => p.symbol),
    };
  } catch (bulkErr) {
    const results = [];
    for (const p of open) {
      try {
        const side = p.holdSide === "short" ? "buy" : "sell";
        const qty = Number(p.total || p.size || 0);
        const order = await placeFuturesOrder({
          symbol: p.symbol,
          side,
          posSide: p.holdSide,
          qty: qty >= 1 ? qty.toFixed(4) : qty.toFixed(6),
          reduceOnly: "YES",
        });
        results.push({
          ok: true,
          category: "futures",
          symbol: p.symbol,
          side: "close",
          posSide: p.holdSide,
          qty,
          order,
        });
        // 写入模拟交易日志
        try {
          const { appendSimTradeLog } = await import("./simulationApi.js");
          appendSimTradeLog({
            ts: new Date().toISOString(),
            source: "chat-agent",
            category: "USDT-FUTURES",
            symbol: p.symbol,
            side: "close",
            posSide: p.holdSide,
            qty: String(qty),
            price: Number(p.markPrice || 0),
            orderType: "market",
            order,
            executed: true,
            decision: { action: "close", reason: `逐笔平仓 ${p.symbol} ${p.holdSide}` },
          });
        } catch { /* ignore */ }
      } catch (err) {
        results.push({
          ok: false,
          category: "futures",
          symbol: p.symbol,
          error: err.message,
        });
      }
    }
    return {
      ok: results.some((r) => r.ok),
      method: "loop",
      count: open.length,
      results,
      closedSymbols: open.map((p) => p.symbol),
      error: bulkErr.message,
    };
  }
}

async function executeCloseAllPositions() {
  if (!isSimApiConfigured()) {
    return { ok: false, error: "模拟 API 未连接" };
  }

  const futures = await executeCloseAllFutures();
  const results = futures.results || [];
  const okN = results.filter((r) => r.ok).length;
  const failN = results.filter((r) => !r.ok).length;

  if (futures.skipped || !futures.count) {
    return { ok: false, error: "当前没有可平的合约持仓" };
  }
  if (!okN) {
    return { ok: false, error: futures.error || "合约平仓失败", results };
  }

  try {
    const { getOrCreateSession, clearSessionEntries } = await import("./paperTrading.js");
    const session = getOrCreateSession("default");
    clearSessionEntries(session, futures.closedSymbols);
  } catch {
    /* ignore */
  }

  const lines = [
    "✅ 合约全部平仓 · 指令已提交",
    `📈 ${futures.method === "bulk" ? "一键平仓" : "逐笔平仓"} · ${futures.count} 个持仓`,
    `汇总：成功 ${okN} · 失败 ${failN}`,
  ];

  return {
    ok: true,
    kind: "multi_trade",
    results,
    content: lines.join("\n"),
  };
}

async function resolveIntentSymbol(text, previousStrategy, intent) {
  const fallback = previousStrategy?.symbol || "BTCUSDT";
  if (intent.type === "close_all_positions" || intent.type === "account" || intent.type === "symbols") {
    return fallback;
  }
  if (intent.type === "scan") {
    const { resolveScanSymbol } = await import("./symbolUtils.js");
    return resolveScanSymbol(text, fallback);
  }
  if (intent.type === "autonomous_strategy") {
    return resolveSymbolFromText(text, fallback);
  }
  return resolveSymbolFromText(text, fallback);
}

export async function handleChatMessage({ message, previousStrategy = null, forcePerception = false }) {
  const text = (message || "").trim();
  if (!text) throw new Error("请输入消息");

  const intent = detectChatIntent(text, previousStrategy);
  const symbol = await resolveIntentSymbol(text, previousStrategy, intent);

  switch (intent.type) {
    case "show_strategy": {
      if (!previousStrategy) {
        return { kind: "error", content: "还没有配置策略，请用自然语言描述或加载预设。" };
      }
      return {
        kind: "strategy",
        content: "这是你当前的策略配置：",
        strategy: previousStrategy,
      };
    }

    case "help":
      return {
        kind: "help",
        content: "我可以帮你做这些事（支持全现货 USDT 交易对）：",
        capabilities: [
          "📊 信号扫描 — 如「扫描 WLD」「扫描 PEPE」「扫描 BTC 信号」",
          "💰 查余额 — 「我的资产」",
          "📋 查挂单 — 「我的挂单」",
          "📈 合约开单 — 「开多 BTC」「强制开多 BTC」「市价单 1x杠杆 100u 多 BTC」",
          "🔻 合约平仓 — 「平多 BTC」「强制平多 BTC」「强制平仓 ETH」",
          "💥 平掉全部仓位 — 「平掉全部仓位」「强制平掉全部仓位」",
          "📈 限价单 — 「限价 73000 开多 BTC 100u」",
          "❌ 撤单 — 「撤销全部挂单」",
          "📈 合约持仓 · ⚡ 执行策略 · 📉 盈亏分析 · 📜 模拟交易日志",
          "⚙️ 改策略 — 任意币种，如「SOL突破20日均线买入40%」（已连接模拟 API 时可启动模拟）",
          "🧠 自主生成 — 「生成 BTC 策略」「帮我设计 WLD 策略」",
          "🔄 换币 — 「把策略换成 AAVE」保留参数只换交易对",
        ],
      };

    case "symbols": {
      const { getCachedSpotSymbols } = await import("./symbolUtils.js");
      const list = await getCachedSpotSymbols();
      return {
        kind: "symbols",
        content: `Bitget 模拟盘支持 ${list.length} 个 USDT 现货交易对，例如：`,
        symbols: list.slice(0, 30),
        total: list.length,
      };
    }

    case "scan": {
      const sym = symbol;
      return buildScanResult(sym, { forcePerception: forcePerception || true });
    }

    case "account": {
      if (!isSimApiConfigured()) {
        return { kind: "error", content: "模拟 API 未连接，请先配置 Bitget Demo Key。" };
      }
      let account;
      if (isAgentHubReady()) {
        try {
          account = await hubGetSimAccountView();
        } catch {
          account = await getSimAccount();
        }
      } else {
        account = await getSimAccount();
      }
      return {
        kind: "account",
        content: "这是你模拟盘的账户资产：",
        account,
      };
    }

    case "orders": {
      if (!isSimApiConfigured()) {
        return { kind: "error", content: "模拟 API 未连接。" };
      }
      const orders = await getSimAllOpenOrders([symbol]);
      return {
        kind: "orders",
        content: orders.length ? `当前有 ${orders.length} 笔未成交挂单（Bitget 实时）：` : "暂无未成交挂单。",
        orders,
      };
    }

    case "futures": {
      if (!isSimApiConfigured()) {
        return { kind: "error", content: "模拟 API 未连接。" };
      }
      let positions = [];
      try {
        positions = isAgentHubReady()
          ? await hubGetFuturesPositions()
          : await getCurrentPositions("USDT-FUTURES");
      } catch (e) {
        return { kind: "error", content: `合约查询失败：${e.message}` };
      }
      return {
        kind: "futures",
        content: positions.length ? `合约持仓 ${positions.length} 笔：` : "暂无合约持仓。",
        positions: Array.isArray(positions) ? positions : [],
      };
    }

    case "cancel": {
      if (!isSimApiConfigured()) {
        return { kind: "error", content: "模拟 API 未连接。" };
      }
      if (intent.all) {
        const results = isAgentHubReady()
          ? await hubCancelAllOrders()
          : await cancelAllAccountOrders();
        const total = results.reduce((s, r) => s + (r.cancelled || 0), 0);
        return {
          kind: "cancel",
          content: total ? `已撤销 ${total} 笔挂单（Agent Hub）。` : "没有可撤销的挂单。",
          results,
        };
      }
      const { cancelAllSpotOrders } = await import("../../../demo-bot/bitget-v3.js");
      const sym = symbol;
      const results = await cancelAllSpotOrders(sym);
      return {
        kind: "cancel",
        content: results.length ? `已撤销 ${results.length} 笔 ${sym} 挂单。` : `${sym} 无挂单。`,
        results,
        symbol: sym,
      };
    }

    case "close_all_positions": {
      const batch = await executeCloseAllPositions();
      if (!batch.ok) {
        return { kind: "error", content: batch.error || "平掉全部仓位失败" };
      }
      return {
        kind: "multi_trade",
        content: batch.content,
        trades: batch.results,
      };
    }

    case "futures_trade": {
      const sym = symbol;
      const result = await executeFuturesTrade({
        text,
        symbol: sym,
        intent,
        strategy: previousStrategy,
      });
      if (!result.ok) {
        return { kind: "error", content: result.error || "合约下单失败", trade: result };
      }
      const dir = result.side === "close" ? "平仓" : result.side === "long" ? "开多" : "开空";
      const typeLabel = result.orderType === "limit" ? "限价" : "市价";
      return {
        kind: "trade",
        content: `✅ 合约${typeLabel}${dir} ${baseCoinFromSymbol(sym)} · ${Number(result.qty).toFixed(6)} @ $${Number(result.price).toFixed(2)}${result.leverage && result.side !== "close" ? ` · ${result.leverage}x` : ""}`,
        trade: result,
      };
    }

    case "autonomous_round": {
      if (!isSimApiConfigured()) {
        return { kind: "error", content: "模拟 API 未连接。" };
      }
      return runAutonomousRound(text, previousStrategy);
    }

    case "tick": {
      if (!isSimApiConfigured()) {
        return { kind: "error", content: "模拟 API 未连接。" };
      }
      if (!previousStrategy) {
        return runAutonomousRound(text, null);
      }
      const strat = {
        ...previousStrategy,
        paramRows: previousStrategy.paramRows?.length
          ? previousStrategy.paramRows
          : buildParamRows(previousStrategy),
      };
      const auto = await runAutonomousStrategyTick(strat, {});
      const tick = auto.tick;
      const agent = auto.agent;
      const strategyCheck = await runStrategyCheck(strat);
      const lastPrice = Number(tick?.account?.lastPrice || 0);
      const perception = tick?.perceptionSnapshot || null;
      const autonomousThought = agent?.decide?.autonomousThought || null;
      const content = buildTickChatContent({
        strategy: strat,
        agent,
        auto,
        strategyCheck,
        lastPrice,
      });
      return {
        kind: "tick",
        content,
        tick,
        agent,
        strategy: strat,
        perception,
        strategyCheck,
        autonomousThought,
        market: lastPrice > 0 ? { symbol: strat.symbol, price: lastPrice } : null,
      };
    }

    case "market": {
      const sym = symbol;
      const live = await fetchBitgetSpotPrice(sym);
      const price = live.lastPrice;
      const perception = await gatherPerception(sym).catch(() => null);
      return {
        kind: "market",
        content: `${sym} Bitget 现价 $${price.toLocaleString(undefined, { maximumFractionDigits: 6 })}`,
        market: { symbol: sym, price, source: "bitget-api" },
        perception,
      };
    }

    case "pnl": {
      if (!isSimApiConfigured()) {
        return { kind: "error", content: "模拟 API 未连接。" };
      }
      const daysMatch = text.match(/(\d+)\s*日/);
      const days = daysMatch ? Math.min(Number(daysMatch[1]), 90) : 30;
      const pnl = await getAccountPnLAnalysis({ days, symbol });
      return {
        kind: "pnl",
        content: `${days} 日盈亏概览（Bitget 实时）`,
        pnl,
      };
    }

    case "logs": {
      const { entries, logs, meta } = await getSimTradeLogs(50);
      return {
        kind: "logs",
        content: entries.length
          ? `模拟交易日志 · 共 ${meta.total} 笔（成交 ${meta.filled} / 失败 ${meta.failed}）`
          : "暂无交易日志。",
        logs,
        entries,
        meta,
      };
    }

    case "strategy_trades": {
      const { entries, meta } = await getSimTradeLogs(100);
      const filled = entries.filter((e) => e.status === "filled");
      if (!filled.length) {
        return {
          kind: "strategy_trades",
          content: "暂无策略交易记录。",
          trades: [],
          meta,
        };
      }

      // Group by strategy
      const byStrategy = {};
      filled.forEach((e) => {
        const stratName = e.strategyName || e.reason?.match(/策略[：:·]\s*(.+?)(?:\s*·|$)/)?.[1] || "未标记策略";
        if (!byStrategy[stratName]) byStrategy[stratName] = [];
        byStrategy[stratName].push(e);
      });

      const summary = Object.entries(byStrategy).map(([name, trades]) => ({
        name,
        count: trades.length,
        buys: trades.filter((t) => /buy|开多|买入/i.test(String(t.side || t.reason || ""))).length,
        sells: trades.filter((t) => /sell|平|卖出/i.test(String(t.side || t.reason || ""))).length,
        symbols: [...new Set(trades.map((t) => t.symbol))],
        latest: trades[0]?.ts,
      }));

      return {
        kind: "strategy_trades",
        content: `策略交易记录 · 共 ${filled.length} 笔成交`,
        trades: filled,
        summary,
        meta,
      };
    }

    case "status": {
      const conn = await getConnectionStatus().catch(() => ({ ok: false }));
      const sim = isSimApiConfigured();
      return {
        kind: "status",
        content: sim ? "Bitget 模拟 API 已连接。" : "Bitget 模拟 API 未配置。",
        status: { simConfigured: sim, bitget: conn },
      };
    }

    case "strategy_resymbol": {
      if (!previousStrategy) {
        return { kind: "error", content: "还没有策略可切换，请先创建或加载预设。" };
      }
      const sym = await resolveSymbolFromText(text, previousStrategy.symbol);
      const { cloneStrategyForSymbol } = await import("./intentParser.js");
      const strategy = cloneStrategyForSymbol(previousStrategy, sym);
      let perception = null;
      try {
        perception = await gatherPerception(sym);
      } catch { /* ignore */ }
      return {
        kind: "strategy",
        content: `已将策略应用到 ${baseCoinFromSymbol(sym)} 👇${perception ? `\n${perceptionLine(perception)}` : ""}${isSimApiConfigured() ? "\n策略已就绪，说「启动策略」开始执行。" : "\n⚠️ 连接模拟 API 后，说策略会自动加入策略池。"}`,
        strategy,
        perception,
        autoStartPaper: false,
      };
    }

    case "autonomous_strategy":
      return buildAutonomousStrategyResultSafe(text, previousStrategy);

    case "chat": {
      const ctx = { previousStrategy, simConnected: isSimApiConfigured() };
      const layer = await handleChatLayer(text, ctx);
      if (layer.action === "strategy") {
        return buildStrategyUpdateResult(text, previousStrategy);
      }
      if (layer.action === "autonomous_strategy") {
        return buildAutonomousStrategyResultSafe(text, previousStrategy);
      }
      if (layer.action === "scan") {
        const sym = symbol || (await resolveIntentSymbol(text, previousStrategy, { type: "scan" }));
        return buildScanResult(sym, { forcePerception: true });
      }
      if (layer.action === "help") {
        return {
          kind: "help",
          content: layer.content || "我可以帮你做这些事：",
          capabilities: [
            "📊 信号扫描 — 如「扫描 WLD」「扫描 PEPE」",
            "💰 查余额 — 「我的资产」",
            "⚙️ 描述策略 — 自然语言写入参数",
            "🧠 自主生成策略 — 「生成 BTC 策略」「帮我设计 WLD 策略」",
            "▶️ 启动策略 — 每 3 秒感知→决策→执行",
          ],
        };
      }
      return { kind: "chat", content: layer.content };
    }

    case "strategy":
      return buildStrategyUpdateResult(text, previousStrategy);

    default:
      return { kind: "chat", content: "未能识别该指令，可以说「帮助」或「扫描 BTC」。" };
  }
}

function slimAgentTrace(agent) {
  if (!agent) return null;
  const pick = (obj, keys) => {
    if (!obj) return undefined;
    const out = {};
    for (const k of keys) {
      if (obj[k] !== undefined) out[k] = obj[k];
    }
    return Object.keys(out).length ? out : undefined;
  };
  return {
    perceive: pick(agent.perceive, [
      "summary",
      "bias",
      "score",
      "signalCount",
      "deepseekUsed",
    ]),
    decide: pick(agent.decide, [
      "strategyAction",
      "finalAction",
      "displayAction",
      "finalReason",
      "evaluation",
      "checks",
      "autonomousThought",
      "agentReason",
      "deepseekUsed",
      "deepseekConfidence",
      "conditionPassRate",
      "conditionChecksPassed",
      "conditionChecksTotal",
      "ruleSuggestion",
      "qwenError",
      "deepseekError",
    ]),
    risk: pick(agent.risk, [
      "passed",
      "reason",
      "paused",
      "drawdownPct",
      "checks",
      "deepseekUsed",
      "deepseekConfidence",
      "deepseekError",
    ]),
    execute: pick(agent.execute, [
      "executed",
      "orderId",
      "error",
      "blockedByRisk",
      "tradeLabel",
      "tradeType",
      "source",
      "apiPath",
    ]),
    exit: pick(agent.exit, [
      "hasPosition",
      "reason",
      "closed",
      "triggered",
      "source",
      "pnlPct",
      "deepseekUsed",
      "deepseekConfidence",
    ]),
  };
}

function slimStrategyForChat(strategy) {
  if (!strategy) return null;
  return {
    symbol: strategy.symbol,
    name: strategy.name,
    type: strategy.type,
    category: strategy.category,
    leverage: strategy.leverage,
    summary: strategy.summary,
    positionPct: strategy.positionPct,
    marginMode: strategy.marginMode,
  };
}

function slimStrategyCheckForChat(check) {
  if (!check) return null;
  return { summary: check.summary, entryReady: check.entryReady };
}

function slimTickForChat(tick) {
  if (!tick) return null;
  return {
    symbol: tick.symbol,
    executed: tick.executed,
    orderError: tick.orderError,
    decision: tick.decision
      ? { action: tick.decision.action, reason: tick.decision.reason }
      : null,
    order: tick.order
      ? {
          orderId: tick.order.orderId,
          tradeLabel: tick.order.tradeLabel,
          category: tick.order.category,
        }
      : null,
  };
}

/** 聊天/SSE 用精简结果，避免 JSON 过大导致 SSE 断流 */
export function slimAutonomousRoundResult(result) {
  if (!result) return result;
  return {
    ...result,
    strategy: slimStrategyForChat(result.strategy),
    strategyCheck: slimStrategyCheckForChat(result.strategyCheck),
    agent: slimAgentTrace(result.agent),
    tick: slimTickForChat(result.tick),
    perception: result.perception?.composite
      ? {
          composite: {
            bias: result.perception.composite.bias,
            score: result.perception.composite.score,
            summary: result.perception.composite.summary,
          },
          deepseekUsed: result.perception.deepseekUsed,
        }
      : null,
  };
}

export function buildAssistantMessage(result, { slim = false } = {}) {
  const payload = slim ? slimAutonomousRoundResult(result) : result;
  const base = {
    role: "assistant",
    content: payload.content,
    time: Date.now(),
    kind: payload.kind,
  };

  if (payload.strategy) base.strategy = payload.strategy;
  if (payload.market) base.market = payload.market;
  if (payload.perception) base.perception = payload.perception;
  if (payload.account) base.account = payload.account;
  if (payload.orders) base.orders = payload.orders;
  if (payload.positions) base.positions = payload.positions;
  if (payload.trade) base.trade = payload.trade;
  if (payload.trades) base.trades = payload.trades;
  if (payload.tick) base.tick = payload.tick;
  if (payload.agent) base.agent = payload.agent;
  if (payload.pnl) base.pnl = payload.pnl;
  if (payload.logs) base.logs = payload.logs;
  if (payload.capabilities) base.capabilities = payload.capabilities;
  if (payload.status) base.status = payload.status;
  if (payload.symbols) base.symbols = payload.symbols;
  if (payload.total != null) base.symbolTotal = payload.total;
  if (payload.results) base.results = payload.results;
  if (payload.strategyCheck) base.strategyCheck = payload.strategyCheck;
  if (payload.autonomousThought) base.autonomousThought = payload.autonomousThought;
  if (payload.generatedBy) base.generatedBy = payload.generatedBy;
  if (payload.autoStartPaper != null) base.autoStartPaper = payload.autoStartPaper;

  return base;
}
