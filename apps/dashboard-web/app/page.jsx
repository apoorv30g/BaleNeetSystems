"use client";

import Shell from "../components/Shell";
import Link from "next/link";
import { useEffect, useState } from "react";
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
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-4xl font-black">Operations Dashboard</h1>
          <p className="mt-2 text-zinc-400">Cold calling, collections and retargeting workflows in one place.</p>
        </div>
        <Link className="btn" href="/campaigns">Create Campaign</Link>
      </div>

      {error && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="mt-8 grid grid-cols-4 gap-4">
        {cards.map(([a,b,c]) => (
          <div className="card p-5" key={a}>
            <p className="text-sm text-zinc-500">{a}</p>
            <p className="mt-3 text-4xl font-black">{b}</p>
            <p className="mt-2 text-xs text-zinc-500">{c}</p>
          </div>
        ))}
      </section>

      <section className="card mt-8 overflow-hidden">
        <div className="border-b border-white/10 p-5">
          <h2 className="text-lg font-bold">Recent Calls</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-white/[0.04] text-left text-zinc-400">
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
              <tr key={call.id} className="border-t border-white/10">
                <td className="p-4">{call.lead_name || "Unknown"}</td>
                <td>{call.phone || "-"}</td>
                <td>{call.playbook_type || "-"}</td>
                <td>{call.status}</td>
                <td>{call.duration_seconds || 0}s</td>
              </tr>
            ))}
            {!analytics?.recentCalls?.length && (
              <tr><td className="p-4 text-zinc-500" colSpan="5">No calls yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-8 grid grid-cols-3 gap-4">
        <div className="card p-6">
          <h2 className="text-lg font-bold">Targeting</h2>
          <p className="mt-2 text-sm text-zinc-400">Cold calling fresh leads from database or campaign uploads.</p>
          <div className="mt-5 rounded-xl bg-blue-500/10 p-4 text-sm text-blue-200">Fresh Lead Playbook</div>
        </div>
        <div className="card p-6">
          <h2 className="text-lg font-bold">Collection</h2>
          <p className="mt-2 text-sm text-zinc-400">Payment reminders before due date and defaulter follow-up after due date.</p>
          <div className="mt-5 space-y-2">
            <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">Soft Reminder</div>
            <div className="rounded-xl bg-red-500/10 p-3 text-sm text-red-200">Hard Reminder</div>
          </div>
        </div>
        <div className="card p-6">
          <h2 className="text-lg font-bold">Retargeting</h2>
          <p className="mt-2 text-sm text-zinc-400">Warm calling existing users who dropped before or after loan approval.</p>
          <div className="mt-5 space-y-2">
            <div className="rounded-xl bg-purple-500/10 p-3 text-sm text-purple-200">Unapproved Users</div>
            <div className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200">Approved Users</div>
          </div>
        </div>
      </section>
    </Shell>
  );
}
