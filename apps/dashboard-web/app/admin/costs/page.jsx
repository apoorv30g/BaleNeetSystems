"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Building2, CheckCircle2, IndianRupee, LogOut, ReceiptText, ShieldCheck } from "lucide-react";
import { apiFetch, clearSession, getUser } from "../../../lib/api";

const periods = [
  ["7", "7 days"],
  ["30", "30 days"],
  ["90", "90 days"],
  ["all", "All time"]
];

export default function AdminCostsPage() {
  const router = useRouter();
  const [period, setPeriod] = useState("30");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const user = getUser();
    if (!user || !["platform_admin", "admin"].includes(user.role)) {
      router.replace("/admin/login");
      return;
    }
  }, [router]);

  useEffect(() => {
    load(period).catch(err => setError(err.message));
  }, [period]);

  async function load(days) {
    setLoading(true);
    setError("");
    try {
      setData(await apiFetch(`/admin/costs?days=${days}`));
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearSession();
    router.replace("/admin/login");
  }

  const configuredCount = useMemo(
    () => (data?.components || []).filter(item => item.configured).length,
    [data]
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/90 px-4 py-4 shadow-sm backdrop-blur sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="brand-mark"><ShieldCheck size={18} /></div>
            <div>
              <h1 className="text-xl font-black text-slate-950">Platform Admin</h1>
              <p className="text-xs font-medium text-slate-500">Cost monitoring</p>
            </div>
          </div>
          <button className="btn-secondary px-4 py-2" onClick={logout}><LogOut size={16} /> Logout</button>
        </div>
        <nav className="mx-auto mt-4 flex max-w-7xl gap-2">
          <Link className="btn-secondary px-4 py-2" href="/admin">Overview</Link>
          <Link className="btn px-4 py-2" href="/admin/costs">Costs</Link>
        </nav>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
                <IndianRupee size={14} /> Vendor cost estimate
              </div>
              <h2 className="mt-3 text-3xl font-black text-slate-950 sm:text-4xl">Costs</h2>
              <p className="mt-2 max-w-2xl text-sm text-slate-500">
                Track usage-driven estimates for Exotel, Sarvam and fallback providers. Use this as an operating view, then reconcile with vendor invoices.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {periods.map(([value, label]) => (
                <button
                  key={value}
                  className={period === value ? "btn px-4 py-2" : "btn-secondary px-4 py-2"}
                  onClick={() => setPeriod(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Estimated Total" value={money(data?.summary?.totalEstimatedInr)} helper={data?.period?.label || "-"} />
          <Metric label="Billable Minutes" value={formatNumber(data?.summary?.billableMinutes)} helper={`${data?.summary?.calls || 0} calls`} />
          <Metric label="Completed Calls" value={formatNumber(data?.summary?.completedCalls)} helper="connected/completed" />
          <Metric label="Rates Configured" value={`${configuredCount}/${data?.components?.length || 0}`} helper="Railway cost vars" />
        </section>

        {!!data?.missingRates?.length && (
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 shrink-0" size={18} />
              <div>
                <p className="font-bold">Some active components have no rate configured.</p>
                <p className="mt-1">Add the missing Railway variables shown below so totals reflect your actual plans.</p>
              </div>
            </div>
          </div>
        )}

        <section className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
          {(data?.components || []).map(item => (
            <div key={item.key} className="card p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest text-sky-600">{item.vendor}</div>
                  <h3 className="mt-2 text-lg font-black text-slate-950">{item.label}</h3>
                  <p className="mt-1 text-sm text-slate-500">{item.rawUsage}</p>
                </div>
                {item.configured ? <CheckCircle2 className="text-emerald-500" size={20} /> : <AlertTriangle className="text-amber-500" size={20} />}
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3">
                <Mini label="Usage" value={formatNumber(item.quantity)} />
                <Mini label={`Rate / ${item.unit}`} value={money(item.rateInr)} />
                <Mini label="Cost" value={money(item.estimatedCostInr)} strong />
              </div>
              {!item.configured && (
                <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                  Configure `{rateVariableFor(item.key)}` in Railway.
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_420px]">
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-200 p-5">
              <Building2 className="text-sky-700" size={18} />
              <h3 className="text-lg font-black text-slate-950">Client Cost Split</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr><th className="p-4">Client</th><th>Calls</th><th>Seconds</th><th>Billable Minutes</th><th>Exotel Estimate</th></tr>
                </thead>
                <tbody>
                  {(data?.clients || []).map(client => (
                    <tr key={client.id} className="border-t border-slate-200">
                      <td className="p-4 font-semibold text-slate-950">{client.name}</td>
                      <td>{formatNumber(client.calls)}</td>
                      <td>{formatNumber(client.durationSeconds)}</td>
                      <td>{formatNumber(client.billableMinutes)}</td>
                      <td className="font-bold text-slate-950">{money(client.estimatedExotelCostInr)}</td>
                    </tr>
                  ))}
                  {!data?.clients?.length && <tr><td className="p-4 text-slate-500" colSpan="5">No client usage yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center gap-2">
              <ReceiptText className="text-emerald-700" size={18} />
              <h3 className="text-lg font-black text-slate-950">Rate Variables</h3>
            </div>
            <div className="mt-4 space-y-2 text-sm">
              {Object.entries(data?.rates || {}).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                  <span className="font-semibold text-slate-600">{key}</span>
                  <span className="font-bold text-slate-950">{formatRateValue(key, value)}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2 text-xs leading-5 text-slate-500">
              {(data?.notes || []).map(note => <p key={note}>{note}</p>)}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, helper }) {
  return (
    <div className="stat-card">
      <p className="text-sm font-semibold text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-black text-slate-950">{value}</p>
      <p className="mt-2 text-xs text-slate-500">{helper}</p>
    </div>
  );
}

function Mini({ label, value, strong = false }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`mt-1 text-sm ${strong ? "font-black text-slate-950" : "font-bold text-slate-700"}`}>{value}</p>
    </div>
  );
}

function money(value) {
  const amount = Number(value || 0);
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatNumber(value) {
  const number = Number(value || 0);
  return number.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatRateValue(key, value) {
  if (key.toLowerCase().includes("count")) return formatNumber(value);
  return money(value);
}

function rateVariableFor(key) {
  return {
    exotel_voice: "EXOTEL_OUTBOUND_COST_PER_MINUTE_INR",
    exotel_attempts: "EXOTEL_ATTEMPT_COST_INR",
    exotel_channels: "EXOTEL_CHANNEL_MONTHLY_COST_INR and EXOTEL_CHANNEL_COUNT",
    exotel_minimum_billing: "EXOTEL_MIN_MONTHLY_BILLING_INR",
    sarvam_stt: "SARVAM_STT_COST_PER_HOUR_INR",
    sarvam_tts: "SARVAM_TTS_COST_PER_1K_CHARS_INR",
    sarvam_llm: "SARVAM_LLM_COST_PER_1K_TOKENS_INR",
    deepgram_stt: "DEEPGRAM_COST_PER_MINUTE_INR",
    gemini_llm: "GEMINI_COST_PER_1K_TOKENS_INR"
  }[key] || "COST_RATE_VARIABLE";
}
