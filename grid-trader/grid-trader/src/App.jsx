import { useState, useRef, useCallback } from "react";
import { Chart, registerables } from "chart.js";
import Papa from "papaparse";
Chart.register(...registerables);

// ── 색상 팔레트 ─────────────────────────────────────
const C = {
  bg: "#0a0e1a", bg2: "#0d1225", bg3: "#141929",
  border: "#1e2a45", border2: "#2a3a5a",
  text: "#e0e6f0", text2: "#6b7a99",
  green: "#4aff9e", blue: "#4a9eff",
  red: "#ff4a4a", gold: "#ffaa4a",
  greenDim: "rgba(29,158,117,0.7)", blueDim: "rgba(55,138,221,0.5)",
  greenBg: "rgba(29,158,117,0.08)", redBg: "rgba(220,53,69,0.08)",
};

const S = {
  card: { background: C.bg3, borderRadius: 8, padding: "12px 14px", marginBottom: 8 },
  cardBorder: (color) => ({ ...S.card, borderLeft: `3px solid ${color}` }),
  row: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 11, color: C.text2 },
  value: (color) => ({ fontSize: 14, fontWeight: 500, color: color || C.text }),
  btn: (active) => ({
    flex: 1, padding: "10px 6px", border: `0.5px solid ${active ? C.border2 : C.border}`,
    borderRadius: 8, background: active ? C.bg3 : "transparent",
    color: active ? C.text : C.text2, fontSize: 12,
    fontWeight: active ? 500 : 400, cursor: "pointer",
  }),
  mainBtn: { width: "100%", padding: 12, background: C.text, color: C.bg,
    border: "none", borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: "pointer" },
  tableHeader: { display: "grid", background: C.bg3, padding: "7px 12px",
    borderRadius: "8px 8px 0 0" },
  tableRow: (i) => ({ display: "grid", padding: "8px 12px",
    borderTop: `0.5px solid ${C.border}`,
    background: i % 2 === 0 ? "transparent" : C.bg3 }),
};

const fmt = (n) => Math.round(n || 0).toLocaleString();
const fmtD = (n) => (n >= 0 ? "+" : "-") + "$" + fmt(Math.abs(n));
const pct = (n, t) => t ? ((n / t) * 100).toFixed(1) + "%" : "0%";

// ── CSV 파서 ─────────────────────────────────────────
function parseCSV(text) {
  const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of result.data) {
    try {
      const keys = Object.keys(row);
      // 날짜 컬럼 찾기
      const dateKey = keys.find(k => k.includes("날짜") || k.toLowerCase().includes("date") || k.toLowerCase().includes("time"));
      // 가격 컬럼 찾기
      const closeKey = keys.find(k => k.includes("종가") || k.toLowerCase() === "close" || k.toLowerCase().includes("price"));
      const highKey = keys.find(k => k.includes("고가") || k.toLowerCase() === "high");
      const lowKey = keys.find(k => k.includes("저가") || k.toLowerCase() === "low");
      const openKey = keys.find(k => k.includes("시가") || k.toLowerCase() === "open");

      if (!dateKey || !closeKey) continue;

      const clean = (v) => parseFloat((v || "0").toString().replace(/,/g, "").replace(/"/g, "").trim());

      const close = clean(row[closeKey]);
      const high = highKey ? clean(row[highKey]) : close * 1.005;
      const low = lowKey ? clean(row[lowKey]) : close * 0.995;
      const open = openKey ? clean(row[openKey]) : close;
      const date = (row[dateKey] || "").toString().replace(/"/g, "").trim();

      if (!close || isNaN(close)) continue;
      rows.push({ date, open, high, low, close });
    } catch { continue; }
  }
  // 날짜 오름차순 정렬
  rows.reverse();
  return rows;
}

// ── 백테스트 엔진 ────────────────────────────────────
function runBacktest({ priceData, gap, profitTarget, initialCash, lotSize, withdrawAt, withdrawTo }) {
  let cash = initialCash;
  let positions = [], pending = [];
  let totalRealized = 0, totalWithdrawn = 0, cycles = 0;
  const daily = [], withdrawals = [], monthly = {};
  const maxPos = Math.min(Math.floor(initialCash / gap / 2), 200);

  const setupGrid = (p) => {
    pending = Array.from({ length: maxPos }, (_, i) =>
      Math.round((p - gap * (i + 1)) * 100) / 100
    );
  };
  setupGrid(priceData[0].close);

  for (const d of priceData) {
    const { date, high, low, close } = d;
    const parts = date.replace(/ /g, "").split("-").filter(Boolean);
    const ym = parts.length >= 2 ? `${parts[0]}-${parts[1].padStart(2,"0")}` : date.slice(0, 7);

    // BUY LIMIT 체결
    const rem = [];
    for (const lp of pending) {
      if (low <= lp) positions.push({ entry: lp, active: true });
      else rem.push(lp);
    }
    pending = rem;

    // 수익 실현
    let dayP = 0;
    for (const pos of positions) {
      if (pos.active && high >= pos.entry + profitTarget) {
        const p = profitTarget * lotSize;
        cash += p; totalRealized += p; dayP += p;
        pos.active = false;
        pending.push(pos.entry);
        pending.sort((a, b) => b - a);
      }
    }

    // 출금
    let withdrawn = 0;
    if (cash >= withdrawAt) {
      withdrawn = cash - withdrawTo;
      totalWithdrawn += withdrawn;
      cash -= withdrawn;
      withdrawals.push({ date, amount: Math.round(withdrawn), cashAfter: Math.round(cash) });
    }

    const active = positions.filter(p => p.active);
    const unreal = active.reduce((s, p) => s + (close - p.entry) * lotSize, 0);
    const equity = cash + unreal;

    if (!monthly[ym]) monthly[ym] = { profit: 0, withdrawn: 0, trades: 0, minEq: Infinity, maxEq: -Infinity };
    monthly[ym].profit += dayP;
    monthly[ym].withdrawn += withdrawn;
    if (dayP > 0) monthly[ym].trades++;
    monthly[ym].minEq = Math.min(monthly[ym].minEq, equity);
    monthly[ym].maxEq = Math.max(monthly[ym].maxEq, equity);

    // 리셋
    if (active.length === 0 && dayP > 0) { cycles++; positions = []; setupGrid(close); }
    daily.push({ date, price: close, active: active.length, unrealized: Math.round(unreal), cash: Math.round(cash), equity: Math.round(equity), withdrawn: Math.round(withdrawn), dayProfit: Math.round(dayP) });
  }

  const equities = daily.map(d => d.equity);
  const cleanMonthly = {};
  for (const [k, v] of Object.entries(monthly)) {
    cleanMonthly[k] = { profit: Math.round(v.profit), withdrawn: Math.round(v.withdrawn), trades: v.trades, minEq: v.minEq === Infinity ? 0 : Math.round(v.minEq), maxEq: v.maxEq === -Infinity ? 0 : Math.round(v.maxEq) };
  }
  return { daily, totalRealized: Math.round(totalRealized), totalWithdrawn: Math.round(totalWithdrawn), finalCash: Math.round(cash), cycles, withdrawals, monthly: cleanMonthly, minEquity: Math.round(Math.min(...equities)), maxEquity: Math.round(Math.max(...equities)) };
}

// ── 히트맵 색상 ──────────────────────────────────────
function heatColor(val, max) {
  if (!val || val === 0) return C.bg3;
  const t = Math.min(val / max, 1);
  return `rgba(29,158,117,${0.15 + t * 0.75})`;
}

// ── CSV 업로드 화면 ──────────────────────────────────
function UploadScreen({ onLoad }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef();

  const handleFile = useCallback((file) => {
    if (!file) return;
    setError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = parseCSV(e.target.result);
        if (data.length < 10) { setError("데이터가 너무 적어요. 최소 10일 이상 필요해요."); return; }
        const assetName = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
        onLoad({ data, name: assetName, file: file.name });
      } catch (err) {
        setError("CSV 파싱 오류: " + err.message);
      }
    };
    reader.readAsText(file, "utf-8");
  }, [onLoad]);

  return (
    <div style={{ padding: "1.5rem 1rem", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* 헤더 */}
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>📊</div>
        <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 4 }}>Grid Trader</div>
        <div style={{ fontSize: 13, color: C.text2 }}>백테스트 & 계산기</div>
      </div>

      {/* 업로드 박스 */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
        onClick={() => fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? C.blue : C.border2}`,
          borderRadius: 16, padding: "36px 20px", textAlign: "center",
          background: dragging ? "rgba(74,158,255,0.05)" : C.bg3,
          cursor: "pointer", marginBottom: 20, transition: "all 0.2s",
        }}
      >
        <div style={{ fontSize: 36, marginBottom: 12 }}>📂</div>
        <div style={{ fontSize: 15, color: C.text, marginBottom: 6 }}>CSV 파일 업로드</div>
        <div style={{ fontSize: 12, color: C.text2, lineHeight: 1.7 }}>
          탭하거나 드래그앤드롭<br />
          Investing.com CSV 형식 지원
        </div>
        <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }}
          onChange={e => handleFile(e.target.files[0])} />
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: C.redBg, border: `0.5px solid ${C.red}`, borderRadius: 8, fontSize: 12, color: C.red, marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      {/* 지원 자산 */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 10 }}>지원 자산 (Investing.com CSV)</div>
        {[
          { emoji: "📈", name: "나스닥 100", ticker: "NAS100" },
          { emoji: "🥇", name: "골드", ticker: "XAUUSD" },
          { emoji: "💱", name: "EUR/USD", ticker: "EURUSD" },
          { emoji: "🛢️", name: "원유 (WTI)", ticker: "USOIL" },
          { emoji: "📊", name: "S&P 500", ticker: "SPX500" },
          { emoji: "🔗", name: "기타 모든 자산", ticker: "..." },
        ].map(a => (
          <div key={a.ticker} style={{ ...S.row, padding: "6px 0", borderBottom: `0.5px solid ${C.border}` }}>
            <span style={{ fontSize: 13 }}>{a.emoji} {a.name}</span>
            <span style={{ fontSize: 11, color: C.blue }}>{a.ticker}</span>
          </div>
        ))}
      </div>

      {/* 다운로드 방법 */}
      <div style={{ ...S.card }}>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 8 }}>📥 CSV 받는 방법</div>
        <div style={{ fontSize: 12, color: C.text, lineHeight: 2 }}>
          1. kr.investing.com 접속<br />
          2. 원하는 자산 검색<br />
          3. <span style={{ color: C.blue }}>역사적 데이터</span> 탭 클릭<br />
          4. 기간 설정 후 <span style={{ color: C.green }}>데이터 다운로드</span>
        </div>
      </div>
    </div>
  );
}

// ── 백테스트 탭 ──────────────────────────────────────
function BacktestTab({ priceData, assetName }) {
  const [params, setParams] = useState({ gap: 50, profitTarget: 300, initialCash: 120000, lotSize: 1, withdrawAt: 130000, withdrawTo: 120000 });
  const [result, setResult] = useState(null);
  const [tab, setTab] = useState("heatmap");
  const equityRef = useRef(), barRef = useRef();
  const charts = useRef({});
  const setP = (k, v) => setParams(p => ({ ...p, [k]: Number(v) }));

  const run = () => {
    const r = runBacktest({ priceData, ...params });
    setResult(r);
    setTab("heatmap");
    setTimeout(() => { drawEquity(r); drawBar(r); }, 150);
  };

  const drawEquity = (r) => {
    if (!equityRef.current) return;
    if (charts.current.eq) charts.current.eq.destroy();
    const step = Math.max(1, Math.floor(r.daily.length / 80));
    const data = r.daily.filter((_, i) => i % step === 0);
    charts.current.eq = new Chart(equityRef.current, {
      type: "line",
      data: {
        labels: data.map(d => d.date.slice(0, 7)),
        datasets: [
          { label: "총자산", data: data.map(d => d.equity), borderColor: "#1D9E75", backgroundColor: C.greenBg, fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: "y" },
          { label: assetName, data: data.map(d => d.price), borderColor: C.blue, backgroundColor: "transparent", fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5, borderDash: [4, 3], yAxisID: "y2" }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.dataset.label + ": $" + Math.round(c.raw).toLocaleString() } } },
        scales: {
          x: { ticks: { color: C.text2, font: { size: 10 }, maxTicksLimit: 8 }, grid: { color: "rgba(255,255,255,0.04)" } },
          y: { position: "left", ticks: { color: "#1D9E75", font: { size: 10 }, callback: v => "$" + Math.round(v / 1000) + "K" }, grid: { color: "rgba(255,255,255,0.04)" } },
          y2: { position: "right", ticks: { color: C.blue, font: { size: 10 }, callback: v => Math.round(v / 1000) + "K" }, grid: { display: false } }
        }
      }
    });
  };

  const drawBar = (r) => {
    if (!barRef.current) return;
    if (charts.current.bar) charts.current.bar.destroy();
    const entries = Object.entries(r.monthly).filter(([, v]) => v.profit > 0 || v.withdrawn > 0);
    charts.current.bar = new Chart(barRef.current, {
      type: "bar",
      data: {
        labels: entries.map(([k]) => k),
        datasets: [
          { label: "수익", data: entries.map(([, v]) => v.profit), backgroundColor: C.greenDim, borderRadius: 3 },
          { label: "출금", data: entries.map(([, v]) => v.withdrawn), backgroundColor: C.blueDim, borderRadius: 3 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.dataset.label + ": $" + Math.round(c.raw).toLocaleString() } } },
        scales: {
          x: { ticks: { color: C.text2, font: { size: 9 }, maxRotation: 45, maxTicksLimit: 20 }, grid: { display: false } },
          y: { ticks: { color: C.text2, font: { size: 10 }, callback: v => "$" + Math.round(v / 1000) + "K" }, grid: { color: "rgba(255,255,255,0.04)" } }
        }
      }
    });
  };

  const switchTab = (t) => {
    setTab(t);
    if (result) setTimeout(() => { if (t === "equity") drawEquity(result); if (t === "monthly") drawBar(result); }, 80);
  };

  // 월/연도 목록 동적 생성
  const allYears = result ? [...new Set(Object.keys(result.monthly).map(k => k.slice(0, 4)))].sort() : [];
  const allMonths = ["01","02","03","04","05","06","07","08","09","10","11","12"];
  const maxProfit = result ? Math.max(1, ...Object.values(result.monthly).map(v => v.profit)) : 1;

  const sliders = [
    { key: "gap", label: "간격 (pt)", min: 10, max: 500, step: 10 },
    { key: "profitTarget", label: "목표수익 (pt)", min: 50, max: 2000, step: 50 },
    { key: "lotSize", label: "랏 사이즈", min: 0.1, max: 10, step: 0.1 },
    { key: "initialCash", label: "초기자금", min: 10000, max: 1000000, step: 10000 },
    { key: "withdrawAt", label: "출금 트리거", min: 10000, max: 1000000, step: 5000 },
    { key: "withdrawTo", label: "출금 후 유지", min: 10000, max: 1000000, step: 5000 },
  ];

  return (
    <div>
      {/* 자산 정보 */}
      <div style={{ ...S.card, ...S.row, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{assetName}</div>
          <div style={{ fontSize: 11, color: C.text2 }}>{priceData.length}일 데이터 · {priceData[0]?.date?.slice(0,10)} ~ {priceData[priceData.length-1]?.date?.slice(0,10)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, color: C.green }}>{fmt(priceData[priceData.length-1]?.close)}</div>
          <div style={{ fontSize: 11, color: C.text2 }}>현재가</div>
        </div>
      </div>

      {/* 슬라이더 */}
      {sliders.map(s => (
        <div key={s.key} style={{ marginBottom: 14 }}>
          <div style={{ ...S.row, marginBottom: 4 }}>
            <span style={S.label}>{s.label}</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>
              {["initialCash","withdrawAt","withdrawTo"].includes(s.key) ? "$" + params[s.key].toLocaleString() : params[s.key]}
            </span>
          </div>
          <input type="range" min={s.min} max={s.max} step={s.step} value={params[s.key]} onChange={e => setP(s.key, e.target.value)} />
        </div>
      ))}

      <button onClick={run} style={{ ...S.mainBtn, marginBottom: 20 }}>백테스트 실행 ↗</button>

      {result && (
        <>
          {/* 서브 탭 */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
            {["heatmap","monthly","equity","summary","withdrawals"].map(t => (
              <button key={t} onClick={() => switchTab(t)} style={{
                fontSize: 11, padding: "5px 9px",
                background: tab === t ? C.bg3 : "transparent",
                color: tab === t ? C.text : C.text2,
                border: `0.5px solid ${tab === t ? C.border2 : "transparent"}`,
                borderRadius: 6, cursor: "pointer"
              }}>
                {t === "heatmap" ? "히트맵" : t === "monthly" ? "월별차트" : t === "equity" ? "자산차트" : t === "summary" ? "요약" : "출금"}
              </button>
            ))}
          </div>

          {/* 히트맵 */}
          {tab === "heatmap" && (
            <div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: "4px", color: C.text2, textAlign: "left", minWidth: 36 }}>연도</th>
                      {allMonths.map(m => <th key={m} style={{ padding: "2px", color: C.text2, textAlign: "center", fontWeight: 400, minWidth: 22 }}>{Number(m)}</th>)}
                      <th style={{ padding: "4px", color: C.text2, textAlign: "right", minWidth: 50 }}>합계</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allYears.map(yr => {
                      const yearTotal = allMonths.reduce((s, m) => s + (result.monthly[`${yr}-${m}`]?.profit || 0), 0);
                      return (
                        <tr key={yr}>
                          <td style={{ padding: "3px 4px", color: C.text2, fontSize: 11, fontWeight: 500 }}>{yr}</td>
                          {allMonths.map(m => {
                            const profit = result.monthly[`${yr}-${m}`]?.profit || 0;
                            return (
                              <td key={m} style={{ padding: "2px" }}>
                                <div title={`${yr}-${m}: $${fmt(profit)}`} style={{ background: heatColor(profit, maxProfit), borderRadius: 3, minHeight: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: profit > maxProfit * 0.4 ? "#fff" : C.text2 }}>
                                  {profit > 0 ? (profit >= 10000 ? Math.round(profit / 1000) + "K" : "") : ""}
                                </div>
                              </td>
                            );
                          })}
                          <td style={{ padding: "3px 4px", textAlign: "right", fontSize: 11, fontWeight: 500, color: yearTotal > 0 ? C.green : C.text2 }}>
                            {yearTotal > 0 ? "+$" + Math.round(yearTotal / 1000) + "K" : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ ...S.card, marginTop: 12 }}>
                <div style={{ fontSize: 11, color: C.text2, lineHeight: 2 }}>
                  🟩 최고 수익월: {(() => { let max = 0, mk = ""; for (const [k, v] of Object.entries(result.monthly)) { if (v.profit > max) { max = v.profit; mk = k; } } return mk + " ($" + fmt(max) + ")"; })()}<br />
                  📊 수익 발생: {Object.values(result.monthly).filter(v => v.profit > 0).length}개월<br />
                  💸 총 출금: ${fmt(result.totalWithdrawn)} ({result.withdrawals.length}회)
                </div>
              </div>
            </div>
          )}

          {/* 월별 차트 */}
          {tab === "monthly" && (
            <div>
              <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 11 }}>
                <span style={{ color: C.text2 }}><span style={{ display: "inline-block", width: 10, height: 10, background: C.greenDim, borderRadius: 2, marginRight: 4 }}></span>수익</span>
                <span style={{ color: C.text2 }}><span style={{ display: "inline-block", width: 10, height: 10, background: C.blueDim, borderRadius: 2, marginRight: 4 }}></span>출금</span>
              </div>
              <div style={{ position: "relative", height: 260 }}>
                <canvas ref={barRef} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14 }}>
                {allYears.map(yr => {
                  const total = Object.entries(result.monthly).filter(([k]) => k.startsWith(yr)).reduce((s, [, v]) => s + v.profit, 0);
                  const wd = Object.entries(result.monthly).filter(([k]) => k.startsWith(yr)).reduce((s, [, v]) => s + v.withdrawn, 0);
                  return total > 0 ? (
                    <div key={yr} style={S.card}>
                      <div style={{ fontSize: 11, color: C.text2, marginBottom: 4 }}>{yr}년</div>
                      <div style={{ fontSize: 15, fontWeight: 500, color: C.green }}>+${fmt(total)}</div>
                      <div style={{ fontSize: 11, color: C.text2 }}>출금 ${fmt(wd)}</div>
                    </div>
                  ) : null;
                })}
              </div>
            </div>
          )}

          {/* 자산 차트 */}
          {tab === "equity" && (
            <div>
              <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 11 }}>
                <span style={{ color: C.text2 }}><span style={{ display: "inline-block", width: 16, height: 2, background: "#1D9E75", marginRight: 4 }}></span>총자산</span>
                <span style={{ color: C.text2 }}><span style={{ display: "inline-block", width: 16, height: 2, background: C.blue, marginRight: 4 }}></span>{assetName}</span>
              </div>
              <div style={{ position: "relative", height: 280 }}>
                <canvas ref={equityRef} />
              </div>
            </div>
          )}

          {/* 요약 */}
          {tab === "summary" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                ["초기자금", "$" + fmt(params.initialCash), C.text],
                ["총 실현수익", "+$" + fmt(result.totalRealized), C.green],
                ["총 출금액", "$" + fmt(result.totalWithdrawn), C.blue],
                ["출금 횟수", result.withdrawals.length + "회", C.text],
                ["계좌 잔액", "$" + fmt(result.finalCash), result.finalCash > params.initialCash ? C.green : C.red],
                ["최저 자산", "$" + fmt(result.minEquity), result.minEquity < 0 ? C.red : C.gold],
                ["완료 사이클", result.cycles + "회", C.text],
                ["수익률", pct(result.totalRealized, params.initialCash), C.green],
                ["청산 여부", result.minEquity > 0 ? "없음 ✓" : "발생 ✗", result.minEquity > 0 ? C.green : C.red],
              ].map(([label, value, color]) => (
                <div key={label} style={{ ...S.row, ...S.card }}>
                  <span style={S.label}>{label}</span>
                  <span style={{ fontSize: 14, fontWeight: 500, color }}>{value}</span>
                </div>
              ))}
            </div>
          )}

          {/* 출금 내역 */}
          {tab === "withdrawals" && (
            <div>
              <div style={{ fontSize: 12, color: C.text2, marginBottom: 10 }}>
                총 {result.withdrawals.length}회 · ${fmt(result.totalWithdrawn)}
              </div>
              <div style={{ border: `0.5px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                <div style={{ ...S.tableHeader, gridTemplateColumns: "1fr 1fr 1fr" }}>
                  {["날짜", "출금액", "잔액"].map(h => <span key={h} style={S.label}>{h}</span>)}
                </div>
                <div style={{ maxHeight: 360, overflowY: "auto" }}>
                  {result.withdrawals.map((w, i) => (
                    <div key={i} style={{ ...S.tableRow(i), gridTemplateColumns: "1fr 1fr 1fr" }}>
                      <span style={{ fontSize: 11, color: C.text2 }}>{w.date.slice(0, 10)}</span>
                      <span style={{ fontSize: 12, color: C.green, fontWeight: 500 }}>+${fmt(w.amount)}</span>
                      <span style={{ fontSize: 12 }}>${fmt(w.cashAfter)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {!result && (
        <div style={{ textAlign: "center", padding: "2rem", color: C.text2, fontSize: 13 }}>
          파라미터 조정 후 실행하세요
        </div>
      )}
    </div>
  );
}

// ── 계산기 탭 ────────────────────────────────────────
function CalcTab({ priceData }) {
  const [calcTab, setCalcTab] = useState("liq");
  const lastPrice = priceData?.[priceData.length - 1]?.close || 29000;

  // 청산 시뮬
  function LiqCalc() {
    const [p, setP] = useState({ gap: 50, cash: 120000, lot: 1 });
    const set = (k, v) => setP(x => ({ ...x, [k]: Number(v) }));
    const rows = [];
    let cum = 0;
    for (let n = 1; n <= 150; n++) {
      cum += p.gap * (n - 1) * p.lot;
      rows.push({ n, cum });
      if (cum >= p.cash) break;
    }
    const safe = rows.filter(r => r.cum < p.cash).slice(-1)[0];
    const liq = rows[rows.length - 1];
    return (
      <div>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 14, lineHeight: 1.7 }}>N번째 랏 체결 시 누적손실과 청산 시점을 계산합니다.</div>
        {[{ key: "gap", label: "간격 (pt)", min: 5, max: 500, step: 5 },
          { key: "cash", label: "보유 자금 ($)", min: 10000, max: 1000000, step: 10000 },
          { key: "lot", label: "랏 사이즈", min: 0.1, max: 10, step: 0.1 }].map(s => (
          <div key={s.key} style={{ marginBottom: 14 }}>
            <div style={{ ...S.row, marginBottom: 4 }}>
              <span style={S.label}>{s.label}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{s.key === "cash" ? "$" + p[s.key].toLocaleString() : p[s.key]}</span>
            </div>
            <input type="range" min={s.min} max={s.max} step={s.step} value={p[s.key]} onChange={e => set(s.key, e.target.value)} />
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          <div style={S.cardBorder(C.green)}>
            <div style={S.label}>안전 마지노선</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: C.green, margin: "4px 0" }}>{safe?.n || 0}번째</div>
            <div style={{ fontSize: 11, color: C.text2 }}>손실 -${fmt(safe?.cum)}</div>
          </div>
          <div style={S.cardBorder(C.red)}>
            <div style={S.label}>청산 발생</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: C.red, margin: "4px 0" }}>{liq?.n}번째</div>
            <div style={{ fontSize: 11, color: C.text2 }}>하락 {fmt(p.gap * (liq?.n || 1))}pt</div>
          </div>
        </div>
        <div style={{ border: `0.5px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ ...S.tableHeader, gridTemplateColumns: "1fr 1fr 1fr" }}>
            {["랏 번호", "하락폭", "누적손실"].map(h => <span key={h} style={S.label}>{h}</span>)}
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {rows.map((r, i) => (
              <div key={r.n} style={{ ...S.tableRow(i), gridTemplateColumns: "1fr 1fr 1fr", background: r.cum >= p.cash ? C.redBg : i % 2 === 0 ? "transparent" : C.bg3 }}>
                <span style={{ fontSize: 12 }}>{r.n}번 {r.cum >= p.cash ? "🚨" : ""}</span>
                <span style={{ fontSize: 12, color: C.text2 }}>-{fmt(p.gap * r.n)}pt</span>
                <span style={{ fontSize: 12, color: r.cum >= p.cash ? C.red : C.text }}>-${fmt(r.cum)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // 역산 계산기
  function RevCalc() {
    const [p, setP] = useState({ currentPrice: Math.round(lastPrice), targetPrice: Math.round(lastPrice * 0.85), cash: 120000, lot: 1 });
    const set = (k, v) => setP(x => ({ ...x, [k]: Number(v) }));
    const drop = Math.max(0, p.currentPrice - p.targetPrice);
    const results = [];
    for (let gap = 5; gap <= 500; gap += 5) {
      const n = Math.floor(drop / gap);
      if (n < 2) continue;
      const cum = gap * (n * (n - 1) / 2) * p.lot;
      results.push({ gap, n, cum, safe: cum < p.cash });
    }
    const best = results.filter(r => r.safe).slice(-1)[0];
    return (
      <div>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 14, lineHeight: 1.7 }}>목표가까지 청산 없이 버티는 최적 간격을 역산합니다.</div>
        {[{ key: "currentPrice", label: "현재가", min: 100, max: 100000, step: 100 },
          { key: "targetPrice", label: "하락 목표가", min: 100, max: 100000, step: 100 },
          { key: "cash", label: "보유 자금 ($)", min: 10000, max: 1000000, step: 10000 },
          { key: "lot", label: "랏 사이즈", min: 0.1, max: 10, step: 0.1 }].map(s => (
          <div key={s.key} style={{ marginBottom: 14 }}>
            <div style={{ ...S.row, marginBottom: 4 }}>
              <span style={S.label}>{s.label}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{["cash"].includes(s.key) ? "$" + p[s.key].toLocaleString() : p[s.key].toLocaleString()}</span>
            </div>
            <input type="range" min={s.min} max={s.max} step={s.step} value={p[s.key]} onChange={e => set(s.key, e.target.value)} />
          </div>
        ))}
        <div style={{ ...S.card, ...S.row, marginBottom: 12 }}>
          <span style={S.label}>총 하락폭</span>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{fmt(drop)}pt ({((drop / (p.currentPrice || 1)) * 100).toFixed(1)}%)</span>
        </div>
        {best && (
          <div style={{ padding: 14, background: C.greenBg, border: `0.5px solid ${C.green}`, borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.text2, marginBottom: 8 }}>✅ 최적 설정</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["간격", best.gap + "pt"], ["포지션", best.n + "개"], ["손실", "-$" + fmt(best.cum)]].map(([l, v]) => (
                <div key={l}><div style={{ fontSize: 10, color: C.text2 }}>{l}</div><div style={{ fontSize: 16, fontWeight: 500 }}>{v}</div></div>
              ))}
            </div>
          </div>
        )}
        <div style={{ border: `0.5px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ ...S.tableHeader, gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
            {["간격", "포지션", "누적손실", ""].map(h => <span key={h} style={S.label}>{h}</span>)}
          </div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {results.filter((_, i) => i % 2 === 0).map((r, i) => (
              <div key={r.gap} style={{ ...S.tableRow(i), gridTemplateColumns: "1fr 1fr 1fr 1fr", background: !r.safe ? C.redBg : i % 2 === 0 ? "transparent" : C.bg3 }}>
                <span style={{ fontSize: 12 }}>{r.gap}pt</span>
                <span style={{ fontSize: 12 }}>{r.n}개</span>
                <span style={{ fontSize: 12, color: r.safe ? C.text : C.red }}>-${fmt(r.cum)}</span>
                <span>{r.safe ? "✅" : "🚨"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // 평균단가
  function AvgCalc() {
    const [p, setP] = useState({ startPrice: Math.round(lastPrice), gap: 50, positions: 10, lot: 1 });
    const [cur, setCur] = useState(Math.round(lastPrice * 0.96));
    const set = (k, v) => setP(x => ({ ...x, [k]: Number(v) }));
    const entries = Array.from({ length: p.positions }, (_, i) => p.startPrice - p.gap * (i + 1));
    const avg = entries.reduce((s, e) => s + e, 0) / entries.length;
    const unreal = entries.reduce((s, e) => s + (cur - e) * p.lot, 0);
    const worst = entries[entries.length - 1];
    return (
      <div>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 14, lineHeight: 1.7 }}>포지션별 평균단가와 실시간 손익을 계산합니다.</div>
        {[{ key: "startPrice", label: "시작가", min: 100, max: 100000, step: 50 },
          { key: "gap", label: "간격 (pt)", min: 5, max: 500, step: 5 },
          { key: "positions", label: "체결 포지션 수", min: 1, max: 100, step: 1 },
          { key: "lot", label: "랏 사이즈", min: 0.1, max: 10, step: 0.1 }].map(s => (
          <div key={s.key} style={{ marginBottom: 14 }}>
            <div style={{ ...S.row, marginBottom: 4 }}>
              <span style={S.label}>{s.label}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{p[s.key].toLocaleString()}</span>
            </div>
            <input type="range" min={s.min} max={s.max} step={s.step} value={p[s.key]} onChange={e => set(s.key, e.target.value)} />
          </div>
        ))}
        <div style={{ marginBottom: 14 }}>
          <div style={{ ...S.row, marginBottom: 4 }}>
            <span style={S.label}>현재가</span>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{cur.toLocaleString()}</span>
          </div>
          <input type="range" min={Math.max(100, worst - 3000)} max={p.startPrice + 2000} step={50} value={cur} onChange={e => setCur(Number(e.target.value))} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[["평균 진입가", fmt(avg), C.text], ["총 랏", p.positions * p.lot + " lot", C.text],
            ["손익분기점", fmt(avg), C.blue], ["최저 진입가", fmt(worst), C.text2],
            ["평가 손익", fmtD(unreal), unreal >= 0 ? C.green : C.red],
            ["최저랏 +300pt", fmt(worst + 300), C.gold]].map(([l, v, c]) => (
            <div key={l} style={S.card}>
              <div style={S.label}>{l}</div>
              <div style={{ fontSize: 15, fontWeight: 500, color: c, marginTop: 4 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 반등 수익
  function RecCalc() {
    const [p, setP] = useState({ startPrice: Math.round(lastPrice), gap: 50, drop: 2000, profitTarget: 300, lot: 1 });
    const set = (k, v) => setP(x => ({ ...x, [k]: Number(v) }));
    const n = Math.floor(p.drop / p.gap);
    const bottom = p.startPrice - p.drop;
    const entries = Array.from({ length: n }, (_, i) => p.startPrice - p.gap * (i + 1));
    const cumLoss = p.gap * (n * (n - 1) / 2) * p.lot;
    const scenarios = [25, 50, 75, 100].map(pct => {
      const recPrice = bottom + p.drop * (pct / 100);
      const realized = entries.filter(e => recPrice >= e + p.profitTarget).length * p.profitTarget * p.lot;
      const unrealized = entries.filter(e => recPrice < e + p.profitTarget).reduce((s, e) => s + (recPrice - e) * p.lot, 0);
      return { pct, recPrice: Math.round(recPrice), realized: Math.round(realized), unrealized: Math.round(unrealized), net: Math.round(realized + unrealized - cumLoss), sold: entries.filter(e => recPrice >= e + p.profitTarget).length };
    });
    return (
      <div>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 14, lineHeight: 1.7 }}>하락 후 반등 시 시나리오별 예상 수익을 계산합니다.</div>
        {[{ key: "startPrice", label: "현재가", min: 100, max: 100000, step: 100 },
          { key: "gap", label: "간격 (pt)", min: 5, max: 500, step: 5 },
          { key: "drop", label: "하락폭 (pt)", min: 100, max: 20000, step: 100 },
          { key: "profitTarget", label: "목표수익 (pt)", min: 50, max: 2000, step: 50 },
          { key: "lot", label: "랏 사이즈", min: 0.1, max: 10, step: 0.1 }].map(s => (
          <div key={s.key} style={{ marginBottom: 14 }}>
            <div style={{ ...S.row, marginBottom: 4 }}>
              <span style={S.label}>{s.label}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{p[s.key].toLocaleString()}</span>
            </div>
            <input type="range" min={s.min} max={s.max} step={s.step} value={p[s.key]} onChange={e => set(s.key, e.target.value)} />
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          {[["체결", n + "개"], ["최저가", fmt(bottom)], ["누적손실", "-$" + fmt(cumLoss)]].map(([l, v]) => (
            <div key={l} style={S.card}><div style={S.label}>{l}</div><div style={{ fontSize: 14, fontWeight: 500, marginTop: 4 }}>{v}</div></div>
          ))}
        </div>
        {scenarios.map(s => (
          <div key={s.pct} style={{ ...S.cardBorder(s.net >= 0 ? C.green : C.gold), marginBottom: 8 }}>
            <div style={{ ...S.row, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>반등 {s.pct}% → {fmt(s.recPrice)}</span>
              <span style={{ fontSize: 14, fontWeight: 500, color: s.net >= 0 ? C.green : C.red }}>{fmtD(s.net)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 11, color: C.text2 }}>
              <span>매도 {s.sold}개 +${fmt(s.realized)}</span>
              <span>평가 {fmtD(s.unrealized)}</span>
              <span>손실 -${fmt(cumLoss)}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const calcTabs = [
    { id: "liq", label: "🚨 청산", comp: <LiqCalc /> },
    { id: "rev", label: "🔍 역산", comp: <RevCalc /> },
    { id: "avg", label: "📊 평균단가", comp: <AvgCalc /> },
    { id: "rec", label: "📈 반등수익", comp: <RecCalc /> },
  ];

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 16 }}>
        {calcTabs.map(t => (
          <button key={t.id} onClick={() => setCalcTab(t.id)} style={{
            padding: "10px 8px", textAlign: "left",
            background: calcTab === t.id ? C.bg3 : "transparent",
            color: calcTab === t.id ? C.text : C.text2,
            border: `0.5px solid ${calcTab === t.id ? C.border2 : C.border}`,
            borderRadius: 8, fontSize: 12, fontWeight: calcTab === t.id ? 500 : 400, cursor: "pointer"
          }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ borderTop: `0.5px solid ${C.border}`, paddingTop: 16 }}>
        {calcTabs.find(t => t.id === calcTab)?.comp}
      </div>
    </div>
  );
}

// ── 메인 앱 ─────────────────────────────────────────
export default function App() {
  const [asset, setAsset] = useState(null);   // { data, name, file }
  const [mainTab, setMainTab] = useState("backtest");

  // 자산 변경
  const handleLoad = useCallback((a) => {
    setAsset(a);
    setMainTab("backtest");
  }, []);

  // 업로드 화면
  if (!asset) return <UploadScreen onLoad={handleLoad} />;

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {/* 상단 바 */}
      <div style={{ background: C.bg2, borderBottom: `0.5px solid ${C.border}`, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Grid Trader</div>
          <div style={{ fontSize: 10, color: C.blue }}>{asset.name}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[{ id: "backtest", label: "📈 백테스트" }, { id: "calc", label: "🧮 계산기" }].map(t => (
            <button key={t.id} onClick={() => setMainTab(t.id)} style={{
              padding: "6px 12px", fontSize: 12,
              background: mainTab === t.id ? C.blue : "transparent",
              color: mainTab === t.id ? "#fff" : C.text2,
              border: `0.5px solid ${mainTab === t.id ? C.blue : C.border}`,
              borderRadius: 20, cursor: "pointer"
            }}>
              {t.label}
            </button>
          ))}
          {/* 자산 변경 버튼 */}
          <button onClick={() => setAsset(null)} style={{ padding: "6px 10px", fontSize: 12, background: "transparent", color: C.text2, border: `0.5px solid ${C.border}`, borderRadius: 20, cursor: "pointer" }}>
            📂
          </button>
        </div>
      </div>

      {/* 콘텐츠 */}
      <div style={{ padding: "16px" }}>
        {mainTab === "backtest" && <BacktestTab priceData={asset.data} assetName={asset.name} />}
        {mainTab === "calc" && <CalcTab priceData={asset.data} />}
      </div>
    </div>
  );
}
