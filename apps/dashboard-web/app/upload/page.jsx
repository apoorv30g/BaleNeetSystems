"use client";

import Shell from "../../components/Shell";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

export default function Upload() {
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState("");
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/campaigns")
      .then(data => {
        setCampaigns(data);
        setCampaignId(data[0]?.id || "");
      })
      .catch(err => setError(err.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setResult(null);

    if (!campaignId) {
      setError("Create a campaign before uploading leads.");
      return;
    }
    if (!file) {
      setError("Choose a CSV file first.");
      return;
    }

    const body = new FormData();
    body.append("file", file);
    setLoading(true);

    try {
      const data = await apiFetch(`/campaigns/${campaignId}/upload`, { method: "POST", body });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="text-3xl font-black text-slate-950 sm:text-4xl">Upload Leads</h1>
        <p className="mt-2 text-sm text-slate-500">CSV format: name, phone, campaignType, playbookType, dropStage, dueDate, loanAmount, offerAmount, language</p>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {result && <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">Inserted {result.inserted}, skipped {result.skipped}, total {result.total}.</div>}

      <form onSubmit={submit} className="card mt-8 p-8">
        <label className="block text-sm font-semibold text-slate-600">Campaign</label>
        <select className="input mt-3" value={campaignId} onChange={e => setCampaignId(e.target.value)} aria-label="Select campaign for CSV upload" title="Select campaign for CSV upload">
          {campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
        </select>
        {campaignId && <Link className="mt-3 inline-block text-sm font-semibold text-sky-700 hover:text-sky-900" href={`/campaigns/${campaignId}`}>Open selected campaign</Link>}
        <label className="mt-6 block text-sm font-semibold text-slate-600">Choose CSV file</label>
        <input className="input mt-3" type="file" accept=".csv,text/csv" aria-label="Upload CSV with lead columns" title="Upload CSV with lead columns" onChange={e => setFile(e.target.files?.[0] || null)} />
        <button className="btn mt-5" disabled={loading}>{loading ? "Uploading..." : "Upload Leads"}</button>
      </form>
    </Shell>
  );
}
