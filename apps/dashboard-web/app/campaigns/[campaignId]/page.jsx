"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Shell from "../../../components/Shell";
import { apiFetch } from "../../../lib/api";

export default function CampaignDetail() {
  const { campaignId } = useParams();
  const router = useRouter();
  const [campaign, setCampaign] = useState(null);
  const [leads, setLeads] = useState([]);
  const [calls, setCalls] = useState([]);
  const [transcripts, setTranscripts] = useState([]);
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({});

  async function load() {
    const [campaignData, leadData, callData, transcriptData] = await Promise.all([
      apiFetch(`/campaigns/${campaignId}`),
      apiFetch(`/campaigns/${campaignId}/leads`),
      apiFetch(`/campaigns/${campaignId}/calls`),
      apiFetch(`/campaigns/${campaignId}/transcripts`)
    ]);
    setCampaign(campaignData);
    setForm({
      name: campaignData.name || "",
      description: campaignData.description || "",
      status: campaignData.status || "draft",
      dailyLimit: campaignData.daily_limit || 200,
      maxAttempts: campaignData.max_attempts || 3,
      language: campaignData.language || "Hinglish"
    });
    setLeads(leadData);
    setCalls(callData);
    setTranscripts(transcriptData);
  }

  useEffect(() => {
    load().catch(err => setError(err.message));
  }, [campaignId]);

  async function upload(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    if (!file) {
      setError("Choose a CSV file first.");
      return;
    }

    const body = new FormData();
    body.append("file", file);
    setLoading(true);
    try {
      const result = await apiFetch(`/campaigns/${campaignId}/upload`, { method: "POST", body });
      setMessage(`Inserted ${result.inserted}, skipped ${result.skipped}, total ${result.total}.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function queueCalls() {
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const result = await apiFetch(`/campaigns/${campaignId}/queue-calls`, { method: "POST" });
      setMessage(`Queued ${result.queued} calls. Blocked ${result.blocked} DNC leads.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function clearQueue() {
    if (!confirm("Remove queued calls for this campaign and reset queued leads to pending?")) return;
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const result = await apiFetch(`/campaigns/${campaignId}/clear-queue`, { method: "POST" });
      setMessage(`Removed ${result.removedJobs} queued jobs. Reset ${result.resetLeads} leads.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveCampaign(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    try {
      await apiFetch(`/campaigns/${campaignId}`, { method: "PUT", body: JSON.stringify(form) });
      setMessage("Campaign updated.");
      setEditOpen(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteCampaign() {
    if (!confirm("Delete this campaign and its leads?")) return;
    await apiFetch(`/campaigns/${campaignId}`, { method: "DELETE" });
    router.replace("/campaigns");
  }

  async function updateOutcome(callId, outcome) {
    await apiFetch(`/campaigns/${campaignId}/calls/${callId}/outcome`, {
      method: "PATCH",
      body: JSON.stringify({ outcome })
    });
    await load();
  }

  async function sendLink(leadId, channel) {
    setError("");
    setMessage("");
    try {
      const event = await apiFetch(`/campaigns/${campaignId}/leads/${leadId}/send-link`, {
        method: "POST",
        body: JSON.stringify({ channel })
      });
      setMessage(`${channel.toUpperCase()} link ${event.status}.`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteLead(leadId) {
    if (!confirm("Remove this lead from the campaign and queue?")) return;
    setError("");
    setMessage("");
    try {
      await apiFetch(`/campaigns/${campaignId}/leads/${leadId}`, { method: "DELETE" });
      setMessage("Lead removed.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const stats = [
    ["Leads", campaign?.lead_count || 0],
    ["Pending", campaign?.pending_count || 0],
    ["Queued", campaign?.queued_count || 0],
    ["Called", campaign?.called_count || 0],
    ["Failed", campaign?.failed_count || 0]
  ];

  return (
    <Shell>
      <div className="flex items-start justify-between gap-6">
        <div>
          <Link href="/campaigns" className="text-sm text-zinc-500 hover:text-white">Campaigns</Link>
          <h1 className="mt-2 text-4xl font-black">{campaign?.name || "Campaign"}</h1>
          <p className="mt-2 text-zinc-400">{campaign?.description || "Upload leads, queue calls and inspect outcomes."}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditOpen(!editOpen)} className="btn-secondary">Edit</button>
          <button onClick={clearQueue} className="btn-secondary" disabled={loading}>Clear Queue</button>
          <button onClick={queueCalls} className="btn" disabled={loading}>Queue Calls</button>
        </div>
      </div>

      {error && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {message && <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

      {editOpen && (
        <form onSubmit={saveCampaign} className="card mt-8 grid grid-cols-2 gap-4 p-6">
          <input className="input" value={form.name || ""} onChange={e => setForm({ ...form, name: e.target.value })} />
          <select className="input" value={form.status || "draft"} onChange={e => setForm({ ...form, status: e.target.value })}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
          </select>
          <input className="input" value={form.description || ""} onChange={e => setForm({ ...form, description: e.target.value })} />
          <input className="input" value={form.language || ""} onChange={e => setForm({ ...form, language: e.target.value })} />
          <input className="input" type="number" value={form.dailyLimit || 200} onChange={e => setForm({ ...form, dailyLimit: Number(e.target.value) })} />
          <input className="input" type="number" value={form.maxAttempts || 3} onChange={e => setForm({ ...form, maxAttempts: Number(e.target.value) })} />
          <button className="btn">Save</button>
          <button type="button" onClick={deleteCampaign} className="btn-secondary">Delete</button>
        </form>
      )}

      <section className="mt-8 grid grid-cols-5 gap-4">
        {stats.map(([label, value]) => (
          <div className="card p-5" key={label}>
            <p className="text-sm text-zinc-500">{label}</p>
            <p className="mt-3 text-3xl font-black">{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-8 grid grid-cols-[360px_1fr] gap-4">
        <form onSubmit={upload} className="card p-6">
          <h2 className="text-lg font-bold">Upload Leads</h2>
          <p className="mt-2 text-sm text-zinc-400">Use the campaign CSV format with at least name, phone and playbookType.</p>
          <input className="input mt-5" type="file" accept=".csv,text/csv" onChange={e => setFile(e.target.files?.[0] || null)} />
          <button className="btn mt-4 w-full" disabled={loading}>{loading ? "Working..." : "Upload CSV"}</button>
        </form>

        <div className="card overflow-hidden">
          <div className="border-b border-white/10 p-5">
            <h2 className="text-lg font-bold">Leads</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-left text-zinc-400">
              <tr><th className="p-4">Name</th><th>Phone</th><th>Playbook</th><th>Status</th><th>Attempts</th><th></th></tr>
            </thead>
            <tbody>
              {leads.map(lead => (
                <tr key={lead.id} className="border-t border-white/10">
                  <td className="p-4">{lead.name || "Unknown"}</td>
                  <td>{lead.phone}</td>
                  <td>{lead.playbook_type}</td>
                  <td>{lead.status}</td>
                  <td>{lead.attempt_count}</td>
                  <td className="pr-4 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => sendLink(lead.id, "sms")} className="btn-secondary">SMS</button>
                      <button onClick={() => deleteLead(lead.id)} className="btn-secondary">Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!leads.length && <tr><td className="p-4 text-zinc-500" colSpan="6">No leads uploaded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 grid grid-cols-2 gap-4">
        <div className="card overflow-hidden">
          <div className="border-b border-white/10 p-5">
            <h2 className="text-lg font-bold">Calls</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-left text-zinc-400">
              <tr><th className="p-4">Lead</th><th>Status</th><th>Outcome</th><th>Duration</th></tr>
            </thead>
            <tbody>
              {calls.map(call => (
                <tr key={call.id} className="border-t border-white/10">
                  <td className="p-4">{call.lead_name || call.phone || "Unknown"}</td>
                  <td>{call.status}</td>
                  <td>
                    <select className="input max-w-44 py-2" value={call.outcome || "IN_PROGRESS"} onChange={e => updateOutcome(call.id, e.target.value)}>
                      {["IN_PROGRESS","INTERESTED","PROMISE_TO_PAY","PAID","CALLBACK","WRONG_NUMBER","DISPUTE","NOT_INTERESTED","OPTED_OUT"].map(outcome => <option key={outcome} value={outcome}>{outcome}</option>)}
                    </select>
                  </td>
                  <td>{call.duration_seconds || 0}s</td>
                </tr>
              ))}
              {!calls.length && <tr><td className="p-4 text-zinc-500" colSpan="4">No calls yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-white/10 p-5">
            <h2 className="text-lg font-bold">Transcripts</h2>
          </div>
          <div className="max-h-[420px] overflow-auto">
            {transcripts.map(item => (
              <div key={item.id} className="border-b border-white/10 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-semibold text-white">{item.lead_name || item.phone || "Unknown"}</span>
                  <span className="text-zinc-500">{item.speaker}</span>
                </div>
                <p className="mt-2 text-zinc-300">{item.text}</p>
              </div>
            ))}
            {!transcripts.length && <div className="p-4 text-sm text-zinc-500">No transcripts yet.</div>}
          </div>
        </div>
      </section>
    </Shell>
  );
}
