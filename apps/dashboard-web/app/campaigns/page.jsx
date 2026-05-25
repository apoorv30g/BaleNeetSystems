"use client";

import Shell from "../../components/Shell";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [playbooks, setPlaybooks] = useState({});
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", campaignType: "RETARGETING", playbookType: "UNAPPROVED_USERS", dailyLimit: 200, maxAttempts: 3, language: "Hinglish" });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadCampaigns() {
    setCampaigns(await apiFetch("/campaigns"));
  }

  useEffect(() => {
    loadCampaigns().catch(err => setError(err.message));
    apiFetch("/playbooks").then(setPlaybooks).catch(() => {});
  }, []);

  async function createCampaign(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    try {
      await apiFetch("/campaigns", { method: "POST", body: JSON.stringify(form) });
      setFormOpen(false);
      setForm({ ...form, name: "", description: "" });
      setMessage("Campaign created.");
      await loadCampaigns();
    } catch (err) {
      setError(err.message);
    }
  }

  async function queueCalls(campaignId) {
    setError("");
    setMessage("");
    try {
      const result = await apiFetch(`/campaigns/${campaignId}/queue-calls`, { method: "POST" });
      setMessage(`Queued ${result.queued} calls. Blocked ${result.blocked} DNC leads.`);
      await loadCampaigns();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Shell>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-4xl font-black">Campaigns</h1>
          <p className="mt-2 text-zinc-400">Create use-case specific voice campaigns.</p>
        </div>
        <button onClick={() => setFormOpen(!formOpen)} className="btn">New Campaign</button>
      </div>

      {error && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {message && <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

      {formOpen && (
        <form onSubmit={createCampaign} className="card mt-8 grid grid-cols-1 gap-4 p-5 md:grid-cols-2 md:p-6">
          <input className="input" placeholder="Campaign name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
          <input className="input" placeholder="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          <select className="input" value={form.campaignType} onChange={e => setForm({ ...form, campaignType: e.target.value })}>
            <option value="RETARGETING">Retargeting</option>
            <option value="COLLECTION">Collection</option>
            <option value="TARGETING">Targeting</option>
          </select>
          <select className="input" value={form.playbookType} onChange={e => setForm({ ...form, playbookType: e.target.value })}>
            {Object.entries(playbooks).map(([key, playbook]) => <option key={key} value={key}>{playbook.title}</option>)}
          </select>
          <input className="input" type="number" min="1" value={form.dailyLimit} onChange={e => setForm({ ...form, dailyLimit: Number(e.target.value) })} />
          <input className="input" type="number" min="1" value={form.maxAttempts} onChange={e => setForm({ ...form, maxAttempts: Number(e.target.value) })} />
          <input className="input" value={form.language} onChange={e => setForm({ ...form, language: e.target.value })} />
          <button className="btn">Create</button>
        </form>
      )}

      <div className="card mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.04] text-left text-zinc-400">
            <tr>
              <th className="p-4">Campaign</th>
              <th>Type</th>
              <th>Playbook</th>
              <th>Status</th>
              <th>Leads</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map(campaign => (
              <tr key={campaign.id} className="border-t border-white/10">
                <td className="p-4">
                  <Link className="font-semibold text-white hover:text-blue-300" href={`/campaigns/${campaign.id}`}>{campaign.name}</Link>
                </td>
                <td>{campaign.campaign_type}</td>
                <td>{campaign.playbook_type}</td>
                <td>{campaign.status}</td>
                <td>{campaign.lead_count || 0}</td>
                <td className="pr-4 text-right">
                  <div className="flex justify-end gap-2">
                    <Link className="btn-secondary" href={`/campaigns/${campaign.id}`}>Open</Link>
                    <button onClick={() => queueCalls(campaign.id)} className="btn-secondary">Queue Calls</button>
                  </div>
                </td>
              </tr>
            ))}
            {!campaigns.length && (
              <tr><td className="p-4 text-zinc-500" colSpan="6">No campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
