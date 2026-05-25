"use client";

import Shell from "../../components/Shell";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

export default function Analytics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/analytics/summary").then(setData).catch(err => setError(err.message));
  }, []);

  const summary = data?.summary || {};
  const totalCalls = Number(summary.total_calls || 0);
  const completed = Number(summary.completed || 0);
  const failed = Number(summary.failed || 0);
  const interested = Number(summary.interested || 0);
  const pickupRate = totalCalls ? `${Math.round((completed / totalCalls) * 100)}%` : "0%";
  const conversionRate = completed ? `${Math.round((interested / completed) * 100)}%` : "0%";

  return (
    <Shell>
      <h1 className="text-4xl font-black">Analytics</h1>
      <p className="mt-2 text-zinc-400">Track pickup, recovery, cost and playbook performance.</p>
      {error && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <div className="mt-8 grid grid-cols-3 gap-4">
        <div className="card p-6"><p className="text-zinc-500">Total Calls</p><p className="mt-3 text-4xl font-black">{summary.total_calls || 0}</p></div>
        <div className="card p-6"><p className="text-zinc-500">Pickup Rate</p><p className="mt-3 text-4xl font-black">{pickupRate}</p></div>
        <div className="card p-6"><p className="text-zinc-500">Conversion</p><p className="mt-3 text-4xl font-black">{conversionRate}</p></div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="card p-6"><p className="text-zinc-500">Interested</p><p className="mt-3 text-4xl font-black">{interested}</p></div>
        <div className="card p-6"><p className="text-zinc-500">Failed</p><p className="mt-3 text-4xl font-black">{failed}</p></div>
        <div className="card p-6"><p className="text-zinc-500">Total Cost</p><p className="mt-3 text-4xl font-black">₹{summary.total_cost || 0}</p></div>
      </div>

      <div className="card mt-8 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.04] text-left text-zinc-400">
            <tr><th className="p-4">Playbook</th><th>Calls</th><th>Interested</th></tr>
          </thead>
          <tbody>
            {(data?.playbooks || []).map(row => (
              <tr key={row.playbook_type} className="border-t border-white/10">
                <td className="p-4">{row.playbook_type}</td>
                <td>{row.calls}</td>
                <td>{row.interested}</td>
              </tr>
            ))}
            {!data?.playbooks?.length && <tr><td className="p-4 text-zinc-500" colSpan="3">No analytics yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
