"use client";

import Shell from "../../components/Shell";
import { useEffect, useState } from "react";
import { BarChart3, IndianRupee, PhoneCall, Target } from "lucide-react";
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
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700"><BarChart3 size={14} /> Performance</div>
        <h1 className="mt-3 text-3xl font-black text-slate-950 sm:text-4xl">Analytics</h1>
        <p className="mt-2 text-sm text-slate-500">Track pickup, recovery, cost and playbook performance.</p>
      </div>
      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Stat icon={PhoneCall} label="Total Calls" value={summary.total_calls || 0} tone="sky" />
        <Stat icon={Target} label="Pickup Rate" value={pickupRate} tone="emerald" />
        <Stat icon={BarChart3} label="Conversion" value={conversionRate} tone="violet" />
        <Stat icon={Target} label="Interested" value={interested} tone="amber" />
        <Stat icon={PhoneCall} label="Failed" value={failed} tone="rose" />
        <Stat icon={IndianRupee} label="Total Cost" value={`₹${summary.total_cost || 0}`} tone="slate" />
      </div>

      <div className="card mt-8 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr><th className="p-4">Playbook</th><th>Calls</th><th>Interested</th></tr>
          </thead>
          <tbody>
            {(data?.playbooks || []).map(row => (
              <tr key={row.playbook_type} className="border-t border-slate-200">
                <td className="p-4 font-semibold text-slate-950">{row.playbook_type}</td>
                <td>{row.calls}</td>
                <td>{row.interested}</td>
              </tr>
            ))}
            {!data?.playbooks?.length && <tr><td className="p-4 text-slate-500" colSpan="3">No analytics yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </div>
    </Shell>
  );
}

function Stat({ icon: Icon, label, value, tone }) {
  const tones = {
    sky: "bg-sky-50 text-sky-700",
    emerald: "bg-emerald-50 text-emerald-700",
    violet: "bg-violet-50 text-violet-700",
    amber: "bg-amber-50 text-amber-700",
    rose: "bg-rose-50 text-rose-700",
    slate: "bg-slate-100 text-slate-700"
  };
  return (
    <div className="stat-card">
      <div className={`grid h-10 w-10 place-items-center rounded-lg ${tones[tone] || tones.slate}`}><Icon size={18} /></div>
      <p className="mt-4 text-sm font-semibold text-slate-500">{label}</p>
      <p className="mt-2 text-4xl font-black text-slate-950">{value}</p>
    </div>
  );
}
