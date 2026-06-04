"use client";

import Shell from "../components/Shell";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Bot, PhoneCall, TrendingUp } from "lucide-react";
import { apiFetch } from "../lib/api";

export default function Dashboard() {
  const [campaigns, setCampaigns] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([apiFetch("/campaigns"), apiFetch("/analytics/summary")])
      .then(([campaignData, analyticsData]) => {
        setCampaigns(campaignData);
        setAnalytics(analyticsData);
      })
      .catch(err => setError(err.message));
  }, []);

  const summary = analytics?.summary || {};
  const activeCampaigns = campaigns.filter(c => c.status === "active").length;
  const queuedCalls = campaigns.reduce((sum, c) => sum + Number(c.queued_count || 0), 0);
  const totalCalls = Number(summary.total_calls || 0);
  const completed = Number(summary.completed || 0);
  const connectRate = totalCalls ? `${Math.round((completed / totalCalls) * 100)}%` : "0%";
  const totalCost = Number(summary.total_cost || 0);
  const avgDuration = Number(summary.avg_duration || 0);
  const costPerMin = avgDuration && completed ? `₹${(totalCost / ((avgDuration * completed) / 60)).toFixed(2)}` : "₹0";

  const cards = [
    ["Active Campaigns", activeCampaigns, `${campaigns.length} total`],
    ["Queued Calls", queuedCalls, "BullMQ queue"],
    ["Connect Rate", connectRate, `${completed}/${totalCalls} completed`],
    ["Cost / Min", costPerMin, "estimated"]
  ];

  return (
    <Shell>
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-sky-50 px-3 py-1 text-xs font-bold text-sky-700"><PhoneCall size={14} /> Voicebot operations</div>
          <h1 className="mt-3 text-3xl font-black text-slate-950 sm:text-4xl">Operations Dashboard</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">Cold calling, collections and retargeting workflows in one place.</p>
        </div>
        <Link className="btn" href="/campaigns">Create Campaign <ArrowUpRight size={16} /></Link>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([a,b,c]) => (
          <div className="stat-card" key={a}>
            <p className="text-sm font-semibold text-slate-500">{a}</p>
            <p className="mt-3 text-4xl font-black text-slate-950">{b}</p>
            <p className="mt-2 text-xs text-slate-500">{c}</p>
          </div>
        ))}
      </section>

      <section className="card mt-8 overflow-hidden">
        <div className="border-b border-slate-200 p-5">
          <h2 className="text-lg font-black text-slate-950">Recent Calls</h2>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="p-4">Lead</th>
              <th>Phone</th>
              <th>Playbook</th>
              <th>Status</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {(analytics?.recentCalls || []).map(call => (
              <tr key={call.id} className="border-t border-slate-200">
                <td className="p-4">{call.lead_name || "Unknown"}</td>
                <td>{call.phone || "-"}</td>
                <td>{call.playbook_type || "-"}</td>
                <td><span className="status-pill">{call.status}</span></td>
                <td>{call.duration_seconds || 0}s</td>
              </tr>
            ))}
            {!analytics?.recentCalls?.length && (
              <tr><td className="p-4 text-slate-500" colSpan="5">No calls yet.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-6">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><TrendingUp size={18} className="text-sky-600" /> Targeting</h2>
          <p className="mt-2 text-sm text-slate-500">Cold calling fresh leads from database or campaign uploads.</p>
          <div className="mt-5 rounded-lg bg-sky-50 p-4 text-sm font-semibold text-sky-800">Fresh Lead Playbook</div>
        </div>
        <div className="card p-6">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><PhoneCall size={18} className="text-emerald-600" /> Collection</h2>
          <p className="mt-2 text-sm text-slate-500">Payment reminders before due date and defaulter follow-up after due date.</p>
          <div className="mt-5 space-y-2">
            <div className="rounded-lg bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">Soft Reminder</div>
            <div className="rounded-lg bg-rose-50 p-3 text-sm font-semibold text-rose-800">Hard Reminder</div>
          </div>
        </div>
        <div className="card p-6">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Bot size={18} className="text-violet-600" /> Retargeting</h2>
          <p className="mt-2 text-sm text-slate-500">Warm calling existing users who dropped before or after loan approval.</p>
          <div className="mt-5 space-y-2">
            <div className="rounded-lg bg-violet-50 p-3 text-sm font-semibold text-violet-800">Unapproved Users</div>
            <div className="rounded-lg bg-amber-50 p-3 text-sm font-semibold text-amber-800">Approved Users</div>
          </div>
        </div>
      </section>
    </Shell>
  );
}
