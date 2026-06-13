"use client";

import Shell from "../../components/Shell";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Megaphone, Plus, RadioTower } from "lucide-react";
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
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700"><RadioTower size={14} /> Call launchpad</div>
          <h1 className="mt-3 text-3xl font-black text-slate-950 sm:text-4xl">Campaigns</h1>
          <p className="mt-2 text-sm text-slate-500">Create use-case specific voice campaigns.</p>
        </div>
        <button onClick={() => setFormOpen(!formOpen)} className="btn"><Plus size={16} /> New Campaign</button>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

      {formOpen && (
        <form onSubmit={createCampaign} className="card mt-8 grid grid-cols-1 gap-4 p-5 md:grid-cols-2 md:p-6">
          <input className="input" placeholder="Campaign name, e.g. June fresh leads" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
          <input className="input" placeholder="Description, e.g. New loan eligibility outreach" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          <select className="input" value={form.campaignType} onChange={e => setForm({ ...form, campaignType: e.target.value })} aria-label="Campaign type" title="Campaign type">
            <option value="RETARGETING">Retargeting</option>
            <option value="COLLECTION">Collection</option>
            <option value="TARGETING">Targeting</option>
          </select>
          <select className="input" value={form.playbookType} onChange={e => setForm({ ...form, playbookType: e.target.value })} aria-label="Playbook" title="Playbook">
            {Object.entries(playbooks).map(([key, playbook]) => <option key={key} value={key}>{playbook.title}</option>)}
          </select>
          <input className="input" type="number" min="1" placeholder="Daily call limit, e.g. 200" aria-label="Daily call limit" title="Daily call limit" value={form.dailyLimit} onChange={e => setForm({ ...form, dailyLimit: Number(e.target.value) })} />
          <input className="input" type="number" min="1" placeholder="Max attempts per lead, e.g. 3" aria-label="Max attempts per lead" title="Max attempts per lead" value={form.maxAttempts} onChange={e => setForm({ ...form, maxAttempts: Number(e.target.value) })} />
          <input className="input" placeholder="Language, e.g. Hinglish, Hindi, English" value={form.language} onChange={e => setForm({ ...form, language: e.target.value })} />
          <button className="btn"><Megaphone size={16} /> Create</button>
        </form>
      )}

      <div className="card mt-8 overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
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
              <tr key={campaign.id} className="border-t border-slate-200">
                <td className="p-4">
                  <Link className="font-bold text-slate-950 hover:text-sky-700" href={`/campaigns/${campaign.id}`}>{campaign.name}</Link>
                </td>
                <td>{campaign.campaign_type}</td>
                <td>{campaign.playbook_type}</td>
                <td><span className="status-pill">{campaign.status}</span></td>
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
              <tr><td className="p-4 text-slate-500" colSpan="6">No campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
