
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Title,
  Filler,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Title,
  Filler
);

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const RUNS = 1000;
const MAX_ATTEMPTS = 10000;
const SAMPLE_PATHS = 5;

type Mode = "manual" | "real";

type Tier = {
  min: number;
  max: number;
  win: number;
  loss: number;
};

type Strategy = {
  id: string;
  title: string;
  description: string;
  initialBalance: number;
  tradeCount?: number;
  totalPnl?: number;
};

type Trade = {
  id: string;
  strategyId: string;
  currencyPair: string;
  outcome: "WIN" | "LOSS";
  netPnl: number;
  commission: number;
  swap: number;
  session: string;
  riskAmount: number | null;
  riskPercent: number | null;
  rMultiple: number | null;
  screenshotBeforeKey: string | null;
  screenshotAfterKey: string | null;
  notes: string;
  tradedAt: string;
};

type ScorePoint = {
  x: number;
  y: number;
};

type ManualPath = {
  attempts: number;
  wins: number;
  score: number;
  reached: boolean;
  points: ScorePoint[];
};

type RealPath = {
  attempts: number;
  finalBalance: number;
  netProfit: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  balances: ScorePoint[];
  drawdowns: ScorePoint[];
};

type Stats = {
  best: number;
  average: number;
  p90: number;
};

const DEFAULT_TIERS: Tier[] = [
  { min: -Infinity, max: -3, win: 1.5, loss: -0.5 },
  { min: -2, max: 2, win: 3, loss: -1 },
  { min: 3, max: Infinity, win: 4.5, loss: -1.5 },
];

const cloneDefaultTiers = () => DEFAULT_TIERS.map((tier) => ({ ...tier }));

const COLORS = [
  "#6366f1",
  "#06b6d4",
  "#f59e0b",
  "#10b981",
  "#ec4899",
];

const fmt = (value: number) =>
  Number.isFinite(value)
    ? value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    : "—";

const money = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const percent = (value: number) => `${value.toFixed(2)}%`;

function getField<T>(
  object: Record<string, unknown>,
  camel: string,
  snake: string,
  fallback: T
): T {
  const value = object[camel] ?? object[snake];
  return value === undefined || value === null ? fallback : (value as T);
}

function normalizeStrategy(raw: Record<string, unknown>): Strategy {
  return {
    id: String(raw.id),
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    initialBalance: Number(
      getField(raw, "initialBalance", "initial_balance", 0)
    ),
    tradeCount: Number(
      getField(raw, "tradeCount", "trade_count", 0)
    ),
    totalPnl: Number(
      getField(raw, "totalPnl", "total_pnl", 0)
    ),
  };
}

function normalizeTrade(raw: Record<string, unknown>): Trade {
  return {
    id: String(raw.id),
    strategyId: String(
      getField(raw, "strategyId", "strategy_id", "")
    ),
    currencyPair: String(
      getField(raw, "currencyPair", "currency_pair", "")
    ),
    outcome: String(raw.outcome ?? "LOSS").toUpperCase() as
      | "WIN"
      | "LOSS",
    netPnl: Number(
      getField(raw, "netPnl", "net_pnl", 0)
    ),
    commission: Number(raw.commission ?? 0),
    swap: Number(raw.swap ?? 0),
    session: String(raw.session ?? ""),
    riskAmount:
      raw.riskAmount != null || raw.risk_amount != null
        ? Number(getField(raw, "riskAmount", "risk_amount", 0))
        : null,
    riskPercent:
      raw.riskPercent != null || raw.risk_percent != null
        ? Number(getField(raw, "riskPercent", "risk_percent", 0))
        : null,
    rMultiple:
      raw.rMultiple != null || raw.r_multiple != null
        ? Number(getField(raw, "rMultiple", "r_multiple", 0))
        : null,
    screenshotBeforeKey: getField(
      raw,
      "screenshotBeforeKey",
      "screenshot_before_key",
      null
    ) as string | null,
    screenshotAfterKey: getField(
      raw,
      "screenshotAfterKey",
      "screenshot_after_key",
      null
    ) as string | null,
    notes: String(raw.notes ?? ""),
    tradedAt: String(
      getField(raw, "tradedAt", "traded_at", "")
    ),
  };
}

// -----------------------------------------------------------------------------
// Statistics
// -----------------------------------------------------------------------------

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1)
  );

  return sorted[index];
}

function calculateStats(
  values: number[],
  higherIsBetter: boolean
): Stats {
  if (!values.length) {
    return { best: 0, average: 0, p90: 0 };
  }

  const average =
    values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    best: higherIsBetter
      ? Math.max(...values)
      : Math.min(...values),
    average,
    // For higher-is-better metrics, the worse 90th-percentile
    // case is the lower 10th percentile.
    // For lower-is-better metrics, it is the upper 90th percentile.
    p90: quantile(values, higherIsBetter ? 0.1 : 0.9),
  };
}

function StatLines({
  stats,
  suffix = "",
}: {
  stats: Stats;
  suffix?: string;
}) {
  return (
    <div className="mt-3 space-y-2 text-sm text-slate-700">
      <div className="flex justify-between gap-2">
        <span>Best case</span>
        <strong>{fmt(stats.best)}{suffix}</strong>
      </div>
      <div className="flex justify-between gap-2">
        <span>Average case</span>
        <strong>{fmt(stats.average)}{suffix}</strong>
      </div>
      <div className="flex justify-between gap-2">
        <span>90th percentile</span>
        <strong>{fmt(stats.p90)}{suffix}</strong>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Manual Monte Carlo
// -----------------------------------------------------------------------------

function simulateManual(
  probability: number,
  target: number,
  startingCounter: number,
  resetOnBreak: boolean,
  tiers: Tier[],
  keepPath: boolean
): ManualPath {
  let score = 0;
  let counter = startingCounter;
  let previousOutcome: "W" | "L" | null = null;
  let wins = 0;
  let attempts = 0;

  const points: ScorePoint[] = keepPath
    ? [{ x: 0, y: 0 }]
    : [];

  const getTier = (currentCounter: number) =>
    tiers.find(
      (tier) =>
        currentCounter >= tier.min &&
        currentCounter <= tier.max
    ) ?? tiers[tiers.length - 1];

  while (score < target && attempts < MAX_ATTEMPTS) {
    const won = Math.random() < probability / 100;
    const outcome = won ? "W" : "L";

    attempts++;

    if (
      resetOnBreak &&
      previousOutcome !== null &&
      outcome !== previousOutcome
    ) {
      counter = 0;
    }

    counter += won ? 1 : -1;

    // The counter is updated before selecting the tier.
    const tier = getTier(counter);

    score += won ? tier.win : tier.loss;

    if (won) wins++;

    previousOutcome = outcome;

    if (keepPath) {
      points.push({ x: attempts, y: score });
    }
  }

  return {
    attempts,
    wins,
    score,
    reached: score >= target,
    points,
  };
}

function runManualSimulation(
  probability: number,
  target: number,
  startingCounter: number,
  resetOnBreak: boolean,
  tiers: Tier[]
) {
  const results = Array.from({ length: RUNS }, () =>
    simulateManual(
      probability,
      target,
      startingCounter,
      resetOnBreak,
      tiers,
      false
    )
  );

  const samples = Array.from({ length: SAMPLE_PATHS }, () =>
    simulateManual(
      probability,
      target,
      startingCounter,
      resetOnBreak,
      tiers,
      true
    )
  );

  return { results, samples };
}

// -----------------------------------------------------------------------------
// Real-data bootstrap Monte Carlo
// -----------------------------------------------------------------------------

function simulateRealPath(
  historicalPnls: number[],
  initialBalance: number,
  tradeHorizon: number,
  keepPath: boolean
): RealPath {
  let balance = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  const balances: ScorePoint[] = keepPath
    ? [{ x: 0, y: balance }]
    : [];

  const drawdowns: ScorePoint[] = keepPath
    ? [{ x: 0, y: 0 }]
    : [];

  for (let attempt = 1; attempt <= tradeHorizon; attempt++) {
    // Bootstrap sampling: select a historical trade with replacement.
    const index = Math.floor(Math.random() * historicalPnls.length);
    const pnl = historicalPnls[index];

    balance += pnl;
    peak = Math.max(peak, balance);

    const drawdown = Math.max(0, peak - balance);
    const drawdownPercent =
      peak > 0 ? (drawdown / peak) * 100 : 0;

    maxDrawdown = Math.max(maxDrawdown, drawdown);
    maxDrawdownPercent = Math.max(
      maxDrawdownPercent,
      drawdownPercent
    );

    if (keepPath) {
      balances.push({ x: attempt, y: balance });
      drawdowns.push({ x: attempt, y: drawdownPercent });
    }
  }

  return {
    attempts: tradeHorizon,
    finalBalance: balance,
    netProfit: balance - initialBalance,
    maxDrawdown,
    maxDrawdownPercent,
    balances,
    drawdowns,
  };
}

function runRealSimulation(
  historicalPnls: number[],
  initialBalance: number,
  tradeHorizon: number
) {
  const results = Array.from({ length: RUNS }, () =>
    simulateRealPath(
      historicalPnls,
      initialBalance,
      tradeHorizon,
      false
    )
  );

  const samples = Array.from({ length: SAMPLE_PATHS }, () =>
    simulateRealPath(
      historicalPnls,
      initialBalance,
      tradeHorizon,
      true
    )
  );

  return { results, samples };
}

// -----------------------------------------------------------------------------
// Chart configuration
// -----------------------------------------------------------------------------

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false as const,
  plugins: {
    legend: {
      position: "bottom" as const,
      labels: {
        usePointStyle: true,
        boxWidth: 8,
        padding: 18,
      },
    },
    tooltip: {
      mode: "index" as const,
      intersect: false,
    },
  },
};

const lineOptions = {
  ...chartOptions,
  parsing: false as const,
  interaction: {
    mode: "nearest" as const,
    intersect: false,
  },
  scales: {
    x: {
      type: "linear" as const,
      title: {
        display: true,
        text: "Attempt number",
      },
      ticks: {
        precision: 0,
      },
      grid: {
        display: false,
      },
    },
  },
};

// -----------------------------------------------------------------------------
// Main page
// -----------------------------------------------------------------------------

export default function Home() {
  // Authentication
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  // Application data
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Strategy form
  const [strategyTitle, setStrategyTitle] = useState("");
  const [strategyDescription, setStrategyDescription] = useState("");
  const [strategyBalance, setStrategyBalance] = useState("10000");
  const [showStrategyForm, setShowStrategyForm] = useState(false);
  const [strategySaving, setStrategySaving] = useState(false);

  // Trade form
  const [pair, setPair] = useState("EURUSD");
  const [outcome, setOutcome] = useState<"WIN" | "LOSS">("WIN");
  const [netAmount, setNetAmount] = useState("");
  const [commission, setCommission] = useState("0");
  const [swap, setSwap] = useState("0");
  const [session, setSession] = useState("London");
  const [riskAmount, setRiskAmount] = useState("");
  const [riskPercent, setRiskPercent] = useState("");
  const [rMultiple, setRMultiple] = useState("");
  const [tradeDate, setTradeDate] = useState(
    new Date().toISOString().slice(0, 16)
  );
  const [notes, setNotes] = useState("");
  const [beforeImage, setBeforeImage] = useState<File | null>(null);
  const [afterImage, setAfterImage] = useState<File | null>(null);
  const [tradeSaving, setTradeSaving] = useState(false);

  // Simulation controls
  const [mode, setMode] = useState<Mode>("manual");

  const [probability, setProbability] = useState(50);
  const [target, setTarget] = useState(10);
  const [startingCounter, setStartingCounter] = useState(0);
  const [resetOnBreak, setResetOnBreak] = useState(true);
  const [tiers, setTiers] = useState<Tier[]>(cloneDefaultTiers);

  const [tradeHorizon, setTradeHorizon] = useState(100);
  const [simulationSeed, setSimulationSeed] = useState(0);

  // ---------------------------------------------------------------------------
  // API helpers
  // ---------------------------------------------------------------------------

  const api = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const response = await fetch(url, {
        ...options,
        credentials: "include",
        headers: {
          ...(options.body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          ...options.headers,
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || data.message || `Request failed (${response.status})`
        );
      }

      return data;
    },
    []
  );

  const refreshData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const strategyResponse = await api("/api/strategies");

      const strategyRows = Array.isArray(strategyResponse)
        ? strategyResponse
        : strategyResponse.strategies ?? [];

      const normalizedStrategies = strategyRows.map(
        (row: Record<string, unknown>) => normalizeStrategy(row)
      );

      setStrategies(normalizedStrategies);

      const activeId =
        selectedStrategyId &&
          normalizedStrategies.some(
            (strategy: Strategy) => strategy.id === selectedStrategyId
          )
          ? selectedStrategyId
          : normalizedStrategies[0]?.id ?? "";

      setSelectedStrategyId(activeId);

      if (activeId) {
        const tradeResponse = await api(
          `/api/trades?strategyId=${encodeURIComponent(activeId)}`
        );

        const tradeRows = Array.isArray(tradeResponse)
          ? tradeResponse
          : tradeResponse.trades ?? [];

        setTrades(
          tradeRows.map((row: Record<string, unknown>) =>
            normalizeTrade(row)
          )
        );
      } else {
        setTrades([]);
      }

      setAuthenticated(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to load data.";

      if (
        message.toLowerCase().includes("unauthorized") ||
        message.includes("401")
      ) {
        setAuthenticated(false);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [api, selectedStrategyId]);

  useEffect(() => {
    refreshData();
  }, []); // Initial authentication check.

  useEffect(() => {
    if (!authenticated || !selectedStrategyId) {
      setTrades([]);
      return;
    }

    let cancelled = false;

    async function loadTrades() {
      try {
        const response = await api(
          `/api/trades?strategyId=${encodeURIComponent(selectedStrategyId)}`
        );

        const rows = Array.isArray(response)
          ? response
          : response.trades ?? [];

        if (!cancelled) {
          setTrades(
            rows.map((row: Record<string, unknown>) =>
              normalizeTrade(row)
            )
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load trades."
          );
        }
      }
    }

    loadTrades();

    return () => {
      cancelled = true;
    };
  }, [authenticated, selectedStrategyId, api]);

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();

    setLoginLoading(true);
    setLoginError("");

    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });

      setPassword("");
      setAuthenticated(true);
      await refreshData();
    } catch (err) {
      setLoginError(
        err instanceof Error ? err.message : "Login failed."
      );
    } finally {
      setLoginLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy creation
  // ---------------------------------------------------------------------------

  async function createStrategy(event: React.FormEvent) {
    event.preventDefault();

    setStrategySaving(true);
    setError("");

    try {
      const result = await api("/api/strategies", {
        method: "POST",
        body: JSON.stringify({
          title: strategyTitle.trim(),
          description: strategyDescription.trim(),
          initialBalance: Number(strategyBalance),
        }),
      });

      const created = normalizeStrategy(
        result.strategy ?? result
      );

      setStrategies((old) => [created, ...old]);
      setSelectedStrategyId(created.id);

      setStrategyTitle("");
      setStrategyDescription("");
      setStrategyBalance("10000");
      setShowStrategyForm(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create strategy."
      );
    } finally {
      setStrategySaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Screenshot upload
  // ---------------------------------------------------------------------------

  async function uploadScreenshot(file: File | null): Promise<string | null> {
    if (!file) return null;

    if (!file.type.startsWith("image/")) {
      throw new Error("Only image files can be uploaded.");
    }

    if (file.size > 8 * 1024 * 1024) {
      throw new Error("Screenshot must be smaller than 8 MB.");
    }

    const upload = await api("/api/upload-url", {
      method: "POST",
      body: JSON.stringify({
        contentType: file.type,
      }),
    });

    const uploadUrl =
      upload.uploadUrl ?? upload.url ?? upload.signedUrl;

    const key = upload.key ?? upload.objectKey;

    if (!uploadUrl || !key) {
      throw new Error(
        "The upload API did not return an upload URL and object key."
      );
    }

    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: file,
    });

    if (!response.ok) {
      throw new Error("Screenshot upload failed.");
    }

    return key;
  }

  // ---------------------------------------------------------------------------
  // Trade creation
  // ---------------------------------------------------------------------------

  async function createTrade(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedStrategyId) {
      setError("Create or select a strategy first.");
      return;
    }

    const amount = Number(netAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid positive trade amount.");
      return;
    }

    setTradeSaving(true);
    setError("");

    try {
      const [beforeKey, afterKey] = await Promise.all([
        uploadScreenshot(beforeImage),
        uploadScreenshot(afterImage),
      ]);

      await api("/api/trades", {
        method: "POST",
        body: JSON.stringify({
          strategyId: selectedStrategyId,
          currencyPair: pair.trim().toUpperCase(),
          outcome,
          // The API receives the trade amount as a positive magnitude.
          // The outcome determines the net P/L sign in the database.
          amount,
          commission: Number(commission || 0),
          swap: Number(swap || 0),
          session,
          riskAmount:
            riskAmount === "" ? null : Number(riskAmount),
          riskPercent:
            riskPercent === "" ? null : Number(riskPercent),
          rMultiple:
            rMultiple === "" ? null : Number(rMultiple),
          notes,
          tradedAt: new Date(tradeDate).toISOString(),
          screenshotBeforeKey: beforeKey,
          screenshotAfterKey: afterKey,
        }),
      });

      setNetAmount("");
      setCommission("0");
      setSwap("0");
      setRiskAmount("");
      setRiskPercent("");
      setRMultiple("");
      setNotes("");
      setBeforeImage(null);
      setAfterImage(null);

      await refreshData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save trade."
      );
    } finally {
      setTradeSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Trade deletion
  // ---------------------------------------------------------------------------

  async function deleteTrade(id: string) {
    if (!window.confirm("Delete this trade?")) return;

    try {
      await api(`/api/trades?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      setTrades((old) => old.filter((trade) => trade.id !== id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not delete trade."
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Selected strategy and historical data
  // ---------------------------------------------------------------------------

  const selectedStrategy = useMemo(
    () => strategies.find((item) => item.id === selectedStrategyId),
    [strategies, selectedStrategyId]
  );

  const historicalPnls = useMemo(
    () => trades.map((trade) => trade.netPnl).filter(Number.isFinite),
    [trades]
  );

  const historicalWinRate = useMemo(() => {
    if (!trades.length) return 0;

    return (
      (trades.filter((trade) => trade.netPnl > 0).length /
        trades.length) *
      100
    );
  }, [trades]);

  const historicalNetPnl = useMemo(
    () => historicalPnls.reduce((sum, value) => sum + value, 0),
    [historicalPnls]
  );

  // ---------------------------------------------------------------------------
  // Simulation calculations
  // ---------------------------------------------------------------------------

  const manualSimulation = useMemo(
    () =>
      runManualSimulation(
        probability,
        target,
        startingCounter,
        resetOnBreak,
        tiers
      ),
    [
      probability,
      target,
      startingCounter,
      resetOnBreak,
      tiers,
      simulationSeed,
    ]
  );

  const realSimulation = useMemo(() => {
    if (
      !selectedStrategy ||
      historicalPnls.length === 0 ||
      tradeHorizon < 1
    ) {
      return null;
    }

    return runRealSimulation(
      historicalPnls,
      selectedStrategy.initialBalance,
      tradeHorizon
    );
  }, [
    historicalPnls,
    selectedStrategy,
    tradeHorizon,
    simulationSeed,
  ]);

  const manualStats = useMemo(() => {
    const results = manualSimulation.results;

    return {
      wins: calculateStats(
        results.map((result) => result.wins),
        false
      ),
      attempts: calculateStats(
        results.map((result) => result.attempts),
        false
      ),
      score: calculateStats(
        results.map((result) => result.score),
        true
      ),
      completionRate:
        (results.filter((result) => result.reached).length / RUNS) *
        100,
      capped: results.some((result) => !result.reached),
    };
  }, [manualSimulation]);

  const realStats = useMemo(() => {
    if (!realSimulation) return null;

    const results = realSimulation.results;

    return {
      finalBalance: calculateStats(
        results.map((result) => result.finalBalance),
        true
      ),
      netProfit: calculateStats(
        results.map((result) => result.netProfit),
        true
      ),
      drawdown: calculateStats(
        results.map((result) => result.maxDrawdown),
        false
      ),
      drawdownPercent: calculateStats(
        results.map((result) => result.maxDrawdownPercent),
        false
      ),
    };
  }, [realSimulation]);

  // ---------------------------------------------------------------------------
  // Chart data: manual mode
  // ---------------------------------------------------------------------------

  const manualBarData = useMemo(() => {
    const stats = manualStats;

    return {
      labels: ["Winners", "Attempts", "Final score"],
      datasets: [
        {
          label: "Best case",
          data: [
            stats.wins.best,
            stats.attempts.best,
            stats.score.best,
          ],
          backgroundColor: "rgba(16,185,129,.75)",
          borderRadius: 7,
        },
        {
          label: "Average case",
          data: [
            stats.wins.average,
            stats.attempts.average,
            stats.score.average,
          ],
          backgroundColor: "rgba(59,130,246,.75)",
          borderRadius: 7,
        },
        {
          label: "90th percentile",
          data: [
            stats.wins.p90,
            stats.attempts.p90,
            stats.score.p90,
          ],
          backgroundColor: "rgba(139,92,246,.75)",
          borderRadius: 7,
        },
      ],
    };
  }, [manualStats]);

  const manualLineData = useMemo(() => {
    const paths = manualSimulation.samples;

    const maxAttempt = Math.max(
      1,
      ...paths.map((path) => path.attempts)
    );

    return {
      datasets: [
        ...paths.map((path, index) => ({
          label: `Path ${index + 1}`,
          data: path.points,
          borderColor: COLORS[index],
          backgroundColor: "transparent",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0,
        })),
        {
          label: "Target",
          data: [
            { x: 0, y: target },
            { x: maxAttempt, y: target },
          ],
          borderColor: "#64748b",
          borderDash: [7, 5],
          borderWidth: 2,
          pointRadius: 0,
        },
      ],
    };
  }, [manualSimulation, target]);

  // ---------------------------------------------------------------------------
  // Chart data: real-data mode
  // ---------------------------------------------------------------------------

  const realBarData = useMemo(() => {
    if (!realStats) return { labels: [], datasets: [] };

    return {
      labels: [
        "Ending balance",
        "Net profit",
        "Maximum drawdown",
      ],
      datasets: [
        {
          label: "Best case",
          data: [
            realStats.finalBalance.best,
            realStats.netProfit.best,
            realStats.drawdown.best,
          ],
          backgroundColor: "rgba(16,185,129,.75)",
          borderRadius: 7,
        },
        {
          label: "Average case",
          data: [
            realStats.finalBalance.average,
            realStats.netProfit.average,
            realStats.drawdown.average,
          ],
          backgroundColor: "rgba(59,130,246,.75)",
          borderRadius: 7,
        },
        {
          label: "90th percentile",
          data: [
            realStats.finalBalance.p90,
            realStats.netProfit.p90,
            realStats.drawdown.p90,
          ],
          backgroundColor: "rgba(139,92,246,.75)",
          borderRadius: 7,
        },
      ],
    };
  }, [realStats]);

  const realBalanceLineData = useMemo(() => {
    if (!realSimulation) return { datasets: [] };

    return {
      datasets: [
        ...realSimulation.samples.map((path, index) => ({
          label: `Path ${index + 1}`,
          data: path.balances,
          borderColor: COLORS[index],
          backgroundColor: "transparent",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0,
        })),
        {
          label: "Starting balance",
          data: [
            {
              x: 0,
              y: selectedStrategy?.initialBalance ?? 0,
            },
            {
              x: tradeHorizon,
              y: selectedStrategy?.initialBalance ?? 0,
            },
          ],
          borderColor: "#64748b",
          borderDash: [7, 5],
          borderWidth: 2,
          pointRadius: 0,
        },
      ],
    };
  }, [realSimulation, selectedStrategy, tradeHorizon]);

  const realDrawdownLineData = useMemo(() => {
    if (!realSimulation) return { datasets: [] };

    return {
      datasets: realSimulation.samples.map((path, index) => ({
        label: `Path ${index + 1}`,
        data: path.drawdowns,
        borderColor: COLORS[index],
        backgroundColor: "transparent",
        pointRadius: 0,
        borderWidth: 2,
        tension: 0,
      })),
    };
  }, [realSimulation]);

  // ---------------------------------------------------------------------------
  // Tier editor
  // ---------------------------------------------------------------------------

  function updateTier(
    index: number,
    field: keyof Tier,
    value: string
  ) {
    setTiers((old) =>
      old.map((tier, i) => {
        if (i !== index) return tier;

        let parsed: number;

        if (field === "min") {
          parsed = value === "" ? -Infinity : Number(value);
        } else if (field === "max") {
          parsed = value === "" ? Infinity : Number(value);
        } else {
          parsed = Number(value);
        }

        return {
          ...tier,
          [field]: parsed,
        };
      })
    );
  }

  function resetSimulation() {
    setProbability(50);
    setTarget(10);
    setStartingCounter(0);
    setResetOnBreak(true);
    setTiers(cloneDefaultTiers());
    setTradeHorizon(100);
    setSimulationSeed((old) => old + 1);
  }

  function rerunSimulation() {
    setSimulationSeed((old) => old + 1);
  }

  // ---------------------------------------------------------------------------
  // Login screen
  // ---------------------------------------------------------------------------

  if (!authenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm"
        >
          <div className="mb-6">
            <div className="mb-3 inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              PRIVATE DASHBOARD
            </div>
            <h1 className="text-2xl font-bold text-slate-900">
              Streak Simulator
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              Sign in to access your trading journal and simulations.
            </p>
          </div>

          <label className="block text-sm font-medium text-slate-700">
            Dashboard password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          {loginError && (
            <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
              {loginError}
            </p>
          )}

          <button
            disabled={loginLoading}
            className="mt-5 w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loginLoading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              <span className="h-2 w-2 rounded-full bg-indigo-500" />
              MONTE CARLO · 1,000 PATHS
            </div>
            <h1 className="text-3xl font-bold tracking-tight">
              Streak Simulator
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Trading journal, streak modeling, and drawdown analysis.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setShowStrategyForm((value) => !value)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
            >
              + New strategy
            </button>
            <button
              onClick={refreshData}
              className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Refresh data
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {error && (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <span>{error}</span>
            <button
              onClick={() => setError("")}
              className="font-bold"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {loading && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            Loading dashboard data...
          </div>
        )}

        {/* Strategy creation */}

        {showStrategyForm && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Create strategy</h2>

            <form
              onSubmit={createStrategy}
              className="mt-4 grid gap-4 md:grid-cols-2"
            >
              <label className="text-sm text-slate-600">
                Strategy name
                <input
                  value={strategyTitle}
                  onChange={(event) =>
                    setStrategyTitle(event.target.value)
                  }
                  required
                  maxLength={150}
                  placeholder="e.g. London Session SMC"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-slate-900"
                />
              </label>

              <label className="text-sm text-slate-600">
                Initial account balance
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={strategyBalance}
                  onChange={(event) =>
                    setStrategyBalance(event.target.value)
                  }
                  required
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-slate-900"
                />
              </label>

              <label className="text-sm text-slate-600 md:col-span-2">
                Description
                <textarea
                  value={strategyDescription}
                  onChange={(event) =>
                    setStrategyDescription(event.target.value)
                  }
                  rows={2}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-slate-900"
                />
              </label>

              <div className="flex gap-2 md:col-span-2">
                <button
                  disabled={strategySaving}
                  className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {strategySaving ? "Saving..." : "Create strategy"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowStrategyForm(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm"
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        {/* Strategy selector */}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <label className="block flex-1 text-sm font-medium text-slate-600">
              Active strategy
              <select
                value={selectedStrategyId}
                onChange={(event) =>
                  setSelectedStrategyId(event.target.value)
                }
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base font-semibold text-slate-900"
              >
                <option value="">Select a strategy</option>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.title}
                  </option>
                ))}
              </select>
            </label>

            {selectedStrategy && (
              <div className="text-sm text-slate-500">
                Initial balance:{" "}
                <strong className="text-slate-900">
                  {fmt(selectedStrategy.initialBalance)}
                </strong>
              </div>
            )}
          </div>

          {!strategies.length && (
            <p className="mt-4 text-sm text-slate-500">
              No strategies yet. Create your first strategy to begin.
            </p>
          )}
        </section>

        {/* Journal summary */}

        {selectedStrategy && (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Logged trades
              </p>
              <p className="mt-2 text-2xl font-bold">{trades.length}</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Historical win rate
              </p>
              <p className="mt-2 text-2xl font-bold">
                {percent(historicalWinRate)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Historical net P/L
              </p>
              <p
                className={`mt-2 text-2xl font-bold ${historicalNetPnl >= 0
                    ? "text-emerald-600"
                    : "text-rose-600"
                  }`}
              >
                {fmt(historicalNetPnl)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Average trade P/L
              </p>
              <p className="mt-2 text-2xl font-bold">
                {fmt(
                  trades.length
                    ? historicalNetPnl / trades.length
                    : 0
                )}
              </p>
            </div>
          </section>
        )}

        {/* Trade entry */}

        {selectedStrategy && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Log a trade</h2>
            <p className="mt-1 text-sm text-slate-500">
              Enter the final net result after commission and swap.
            </p>

            <form
              onSubmit={createTrade}
              className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            >
              <label className="text-sm text-slate-600">
                Currency pair
                <input
                  value={pair}
                  onChange={(event) => setPair(event.target.value)}
                  required
                  placeholder="EURUSD"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600">
                Outcome
                <select
                  value={outcome}
                  onChange={(event) =>
                    setOutcome(event.target.value as "WIN" | "LOSS")
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5"
                >
                  <option value="WIN">Win</option>
                  <option value="LOSS">Loss</option>
                </select>
              </label>

              <label className="text-sm text-slate-600">
                Final net amount
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={netAmount}
                  onChange={(event) => setNetAmount(event.target.value)}
                  required
                  placeholder="e.g. 150"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600">
                Commission
                <input
                  type="number"
                  step="0.01"
                  value={commission}
                  onChange={(event) =>
                    setCommission(event.target.value)
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600">
                Swap
                <input
                  type="number"
                  step="0.01"
                  value={swap}
                  onChange={(event) => setSwap(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600">
                Trading session
                <select
                  value={session}
                  onChange={(event) => setSession(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5"
                >
                  <option>London</option>
                  <option>New York</option>
                  <option>Asian</option>
                  <option>London / New York overlap</option>
                  <option>Other</option>
                </select>
              </label>

              <label className="text-sm text-slate-600">
                Risk amount (optional)
                <input
                  type="number"
                  step="0.01"
                  value={riskAmount}
                  onChange={(event) =>
                    setRiskAmount(event.target.value)
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600">
                Risk percentage (optional)
                <input
                  type="number"
                  step="0.01"
                  value={riskPercent}
                  onChange={(event) =>
                    setRiskPercent(event.target.value)
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600">
                R multiple (optional)
                <input
                  type="number"
                  step="0.01"
                  value={rMultiple}
                  onChange={(event) =>
                    setRMultiple(event.target.value)
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600 sm:col-span-2 lg:col-span-3">
                Trade date and time
                <input
                  type="datetime-local"
                  value={tradeDate}
                  onChange={(event) => setTradeDate(event.target.value)}
                  required
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <label className="text-sm text-slate-600">
                Before screenshot
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) =>
                    setBeforeImage(event.target.files?.[0] ?? null)
                  }
                  className="mt-2 block w-full text-sm"
                />
              </label>

              <label className="text-sm text-slate-600">
                After screenshot
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) =>
                    setAfterImage(event.target.files?.[0] ?? null)
                  }
                  className="mt-2 block w-full text-sm"
                />
              </label>

              <label className="text-sm text-slate-600 sm:col-span-2 lg:col-span-3">
                Notes
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={3}
                  placeholder="Setup, execution, mistakes, observations..."
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5"
                />
              </label>

              <div className="sm:col-span-2 lg:col-span-3">
                <button
                  disabled={tradeSaving}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {tradeSaving ? "Saving trade..." : "Save trade"}
                </button>
              </div>
            </form>
          </section>
        )}

        {/* Trade history */}

        {selectedStrategy && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Trade history</h2>
                <p className="text-sm text-slate-500">
                  Historical trades for the selected strategy.
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                {trades.length} trades
              </span>
            </div>

            {trades.length === 0 ? (
              <p className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">
                No trades logged for this strategy yet.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[850px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-3 pr-4">Date</th>
                      <th className="py-3 pr-4">Pair</th>
                      <th className="py-3 pr-4">Outcome</th>
                      <th className="py-3 pr-4">Net P/L</th>
                      <th className="py-3 pr-4">Session</th>
                      <th className="py-3 pr-4">R multiple</th>
                      <th className="py-3 pr-4">Notes</th>
                      <th className="py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((trade) => (
                      <tr
                        key={trade.id}
                        className="border-b border-slate-100"
                      >
                        <td className="py-3 pr-4 whitespace-nowrap">
                          {trade.tradedAt
                            ? new Date(trade.tradedAt).toLocaleString()
                            : "—"}
                        </td>
                        <td className="py-3 pr-4 font-semibold">
                          {trade.currencyPair}
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-semibold ${trade.netPnl >= 0
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-rose-50 text-rose-700"
                              }`}
                          >
                            {trade.outcome}
                          </span>
                        </td>
                        <td
                          className={`py-3 pr-4 font-semibold ${trade.netPnl >= 0
                              ? "text-emerald-600"
                              : "text-rose-600"
                            }`}
                        >
                          {fmt(trade.netPnl)}
                        </td>
                        <td className="py-3 pr-4">{trade.session || "—"}</td>
                        <td className="py-3 pr-4">
                          {trade.rMultiple ?? "—"}
                        </td>
                        <td className="max-w-[220px] truncate py-3 pr-4">
                          {trade.notes || "—"}
                        </td>
                        <td className="py-3">
                          <button
                            onClick={() => deleteTrade(trade.id)}
                            className="text-xs font-semibold text-rose-600 hover:text-rose-800"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Simulation mode */}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-bold">Monte Carlo simulator</h2>
              <p className="mt-1 text-sm text-slate-500">
                Compare a theoretical streak model against historical trade outcomes.
              </p>
            </div>

            <div className="flex rounded-xl bg-slate-100 p-1">
              <button
                onClick={() => setMode("manual")}
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${mode === "manual"
                    ? "bg-white text-indigo-700 shadow-sm"
                    : "text-slate-600"
                  }`}
              >
                Manual model
              </button>
              <button
                onClick={() => setMode("real")}
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${mode === "real"
                    ? "bg-white text-indigo-700 shadow-sm"
                    : "text-slate-600"
                  }`}
              >
                Real data
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {RUNS.toLocaleString()} independent simulation paths
            </p>
            <div className="flex gap-2">
              <button
                onClick={resetSimulation}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Reset defaults
              </button>
              <button
                onClick={rerunSimulation}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
              >
                Run again
              </button>
            </div>
          </div>
        </section>

        {/* Manual mode */}

        {mode === "manual" && (
          <>
            <section className="grid gap-5 lg:grid-cols-[340px_1fr]">
              <aside className="space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Win probability</h3>
                    <span className="text-xs text-slate-500">10%–95%</span>
                  </div>

                  <div className="mt-5 text-center">
                    <p className="text-4xl font-bold text-indigo-700">
                      {probability}%
                    </p>
                    <p className="text-xs text-slate-500">
                      probability per attempt
                    </p>
                  </div>

                  <input
                    type="range"
                    min="10"
                    max="95"
                    value={probability}
                    onChange={(event) =>
                      setProbability(Number(event.target.value))
                    }
                    className="mt-5 w-full accent-indigo-600"
                  />

                  <div className="mt-1 flex justify-between text-xs text-slate-400">
                    <span>10%</span>
                    <span>50%</span>
                    <span>95%</span>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="font-semibold">Simulation settings</h3>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <label className="text-sm text-slate-600">
                      Target score
                      <input
                        type="number"
                        min="0.1"
                        step="0.5"
                        value={target}
                        onChange={(event) =>
                          setTarget(
                            Math.max(0.1, Number(event.target.value) || 0.1)
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                      />
                    </label>

                    <label className="text-sm text-slate-600">
                      Starting counter
                      <input
                        type="number"
                        step="1"
                        value={startingCounter}
                        onChange={(event) =>
                          setStartingCounter(
                            Number(event.target.value) || 0
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                      />
                    </label>
                  </div>

                  <label className="mt-4 flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm">
                    <span>
                      <strong className="block text-slate-800">
                        Reset counter on streak break
                      </strong>
                      <span className="text-xs text-slate-500">
                        Reset to zero when outcome changes.
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={resetOnBreak}
                      onChange={(event) =>
                        setResetOnBreak(event.target.checked)
                      }
                      className="h-5 w-5 accent-indigo-600"
                    />
                  </label>

                  <p className="mt-3 rounded-lg bg-indigo-50 p-3 text-xs leading-5 text-indigo-800">
                    Counter updates before tier selection. A win increases
                    the counter by one; a loss decreases it by one.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold">Counter tiers</h3>
                    <span className="text-xs text-slate-500">
                      Inclusive bounds
                    </span>
                  </div>

                  <div className="mt-4 space-y-3">
                    {tiers.map((tier, index) => (
                      <div
                        key={index}
                        className="rounded-xl border border-slate-200 p-3"
                      >
                        <div className="mb-3 flex items-center justify-between">
                          <span className="text-xs font-semibold text-slate-500">
                            Tier {index + 1}
                          </span>
                          <button
                            type="button"
                            disabled={tiers.length === 1}
                            onClick={() =>
                              setTiers((old) =>
                                old.filter((_, i) => i !== index)
                              )
                            }
                            className="text-xs font-semibold text-rose-600 disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-slate-500">
                            Min counter
                            <input
                              type="number"
                              step="1"
                              placeholder="−∞"
                              value={
                                tier.min === -Infinity ? "" : tier.min
                              }
                              onChange={(event) =>
                                updateTier(index, "min", event.target.value)
                              }
                              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                            />
                          </label>

                          <label className="text-xs text-slate-500">
                            Max counter
                            <input
                              type="number"
                              step="1"
                              placeholder="+∞"
                              value={
                                tier.max === Infinity ? "" : tier.max
                              }
                              onChange={(event) =>
                                updateTier(index, "max", event.target.value)
                              }
                              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                            />
                          </label>

                          <label className="text-xs text-slate-500">
                            Win points
                            <input
                              type="number"
                              step="0.1"
                              value={tier.win}
                              onChange={(event) =>
                                updateTier(index, "win", event.target.value)
                              }
                              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                            />
                          </label>

                          <label className="text-xs text-slate-500">
                            Loss points
                            <input
                              type="number"
                              step="0.1"
                              value={tier.loss}
                              onChange={(event) =>
                                updateTier(index, "loss", event.target.value)
                              }
                              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setTiers((old) => [
                        ...old,
                        {
                          min: -Infinity,
                          max: Infinity,
                          win: 3,
                          loss: -1,
                        },
                      ])
                    }
                    className="mt-4 w-full rounded-xl border border-dashed border-indigo-300 bg-indigo-50 px-3 py-2.5 text-sm font-semibold text-indigo-700"
                  >
                    + Add counter tier
                  </button>

                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    Empty bounds mean negative or positive infinity.
                    Overlapping tiers use the first matching row.
                  </p>
                </div>
              </aside>

              <div className="space-y-5">
                <section className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      Win probability
                    </p>
                    <p className="mt-2 text-2xl font-bold">
                      {probability}%
                    </p>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      Completion rate
                    </p>
                    <p className="mt-2 text-2xl font-bold">
                      {percent(manualStats.completionRate)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      Target score
                    </p>
                    <p className="mt-2 text-2xl font-bold">
                      {fmt(target)}
                    </p>
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div>
                    <h3 className="text-lg font-semibold">
                      Outcome estimates
                    </h3>
                    <p className="text-sm text-slate-500">
                      Best · Average · 90th percentile (worse case)
                    </p>
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl bg-emerald-50 p-4">
                      <p className="text-xs font-semibold uppercase text-emerald-700">
                        Winners needed
                      </p>
                      <StatLines stats={manualStats.wins} />
                    </div>

                    <div className="rounded-xl bg-sky-50 p-4">
                      <p className="text-xs font-semibold uppercase text-sky-700">
                        Total attempts
                      </p>
                      <StatLines stats={manualStats.attempts} />
                    </div>

                    <div className="rounded-xl bg-violet-50 p-4">
                      <p className="text-xs font-semibold uppercase text-violet-700">
                        Final score
                      </p>
                      <StatLines stats={manualStats.score} />
                    </div>
                  </div>

                  <div className="mt-6 h-[320px]">
                    <Bar
                      data={manualBarData}
                      options={{
                        ...chartOptions,
                        scales: {
                          x: {
                            grid: { display: false },
                          },
                          y: {
                            beginAtZero: true,
                            title: {
                              display: true,
                              text: "Value",
                            },
                          },
                        },
                      }}
                    />
                  </div>

                  {manualStats.capped && (
                    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                      Some paths reached the 10,000-attempt safety limit
                      without reaching the target. Their results are
                      capped and are included in the statistics.
                    </p>
                  )}
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold">
                    Sample score trajectories
                  </h3>
                  <p className="text-sm text-slate-500">
                    Five independent sample paths. Dashed line represents
                    the target score.
                  </p>

                  <div className="mt-5 h-[350px]">
                    <Line
                      data={manualLineData}
                      options={{
                        ...lineOptions,
                        scales: {
                          ...lineOptions.scales,
                          y: {
                            title: {
                              display: true,
                              text: "Cumulative score",
                            },
                          },
                        },
                      }}
                    />
                  </div>
                </section>
              </div>
            </section>
          </>
        )}

        {/* Real-data mode */}

        {mode === "real" && (
          <>
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold">
                    Historical bootstrap settings
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Randomly resamples your historical net P/L values
                    with replacement.
                  </p>
                </div>

                <label className="block text-sm text-slate-600">
                  Number of simulated trades
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={tradeHorizon}
                    onChange={(event) =>
                      setTradeHorizon(
                        Math.min(
                          10000,
                          Math.max(1, Number(event.target.value) || 1)
                        )
                      )
                    }
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 sm:w-48"
                  />
                </label>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="text-xs uppercase text-slate-500">
                    Historical trades
                  </p>
                  <p className="mt-1 text-2xl font-bold">
                    {trades.length}
                  </p>
                </div>

                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="text-xs uppercase text-slate-500">
                    Historical win rate
                  </p>
                  <p className="mt-1 text-2xl font-bold">
                    {percent(historicalWinRate)}
                  </p>
                </div>

                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="text-xs uppercase text-slate-500">
                    Historical net P/L
                  </p>
                  <p className="mt-1 text-2xl font-bold">
                    {fmt(historicalNetPnl)}
                  </p>
                </div>
              </div>
            </section>

            {!trades.length ? (
              <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
                Log at least one trade for this strategy before running
                the real-data bootstrap simulation.
              </section>
            ) : (
              <>
                {realStats && (
                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h3 className="text-lg font-semibold">
                      Real-data outcome estimates
                    </h3>
                    <p className="mt-1 text-sm text-slate-500">
                      1,000 paths · {tradeHorizon} simulated trades per path
                    </p>

                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl bg-emerald-50 p-4">
                        <p className="text-xs font-semibold uppercase text-emerald-700">
                          Ending balance
                        </p>
                        <StatLines
                          stats={realStats.finalBalance}
                        />
                      </div>

                      <div className="rounded-xl bg-sky-50 p-4">
                        <p className="text-xs font-semibold uppercase text-sky-700">
                          Net profit
                        </p>
                        <StatLines
                          stats={realStats.netProfit}
                        />
                      </div>

                      <div className="rounded-xl bg-rose-50 p-4">
                        <p className="text-xs font-semibold uppercase text-rose-700">
                          Maximum drawdown
                        </p>
                        <StatLines
                          stats={realStats.drawdown}
                        />
                      </div>

                      <div className="rounded-xl bg-violet-50 p-4">
                        <p className="text-xs font-semibold uppercase text-violet-700">
                          Maximum drawdown %
                        </p>
                        <StatLines
                          stats={realStats.drawdownPercent}
                          suffix="%"
                        />
                      </div>
                    </div>

                    <div className="mt-6 h-[350px]">
                      <Bar
                        data={realBarData}
                        options={{
                          ...chartOptions,
                          scales: {
                            x: {
                              grid: { display: false },
                            },
                            y: {
                              title: {
                                display: true,
                                text: "Account currency",
                              },
                            },
                          },
                        }}
                      />
                    </div>
                  </section>
                )}

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold">
                    Simulated account balance
                  </h3>
                  <p className="text-sm text-slate-500">
                    Five sample balance paths from historical trade
                    outcomes.
                  </p>

                  <div className="mt-5 h-[350px]">
                    <Line
                      data={realBalanceLineData}
                      options={{
                        ...lineOptions,
                        scales: {
                          ...lineOptions.scales,
                          y: {
                            title: {
                              display: true,
                              text: "Account balance",
                            },
                          },
                        },
                      }}
                    />
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold">
                    Drawdown trajectories
                  </h3>
                  <p className="text-sm text-slate-500">
                    Peak-to-trough drawdown as a percentage of the
                    previous equity peak.
                  </p>

                  <div className="mt-5 h-[350px]">
                    <Line
                      data={realDrawdownLineData}
                      options={{
                        ...lineOptions,
                        scales: {
                          ...lineOptions.scales,
                          y: {
                            beginAtZero: true,
                            title: {
                              display: true,
                              text: "Drawdown (%)",
                            },
                          },
                        },
                      }}
                    />
                  </div>
                </section>
              </>
            )}
          </>
        )}

        <footer className="pb-8 text-xs leading-5 text-slate-500">
          Monte Carlo simulations are estimates, not forecasts or
          guarantees. Manual mode uses independent win/loss outcomes.
          Real-data mode resamples historical trade P/L with replacement.
          Historical bootstrap assumes the observed trade distribution
          remains representative; it does not model changing market
          regimes, trade correlations, or future changes in position size.
        </footer>
      </div>
    </main>
  );
}
