"use client";

import Shell from "../../components/Shell";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

const blankForm = {
  key: "",
  title: "",
  category: "Custom",
  task: "",
  trigger: "",
  cadence: "",
  goal: "",
  opening: "",
  qualification: "",
  objectionHandling: "",
  successCondition: "",
  stopCondition: "",
  outcomeFields: "intent, confidence, reason, next action, objection",
  steps: ""
};

export default function Playbooks() {
  const [playbooks, setPlaybooks] = useState({});
  const [formOpen, setFormOpen] = useState(false);
  const [editingKey, setEditingKey] = useState("");
  const [form, setForm] = useState(blankForm);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setPlaybooks(await apiFetch("/playbooks"));
  }

  useEffect(() => {
    load().catch(err => setError(err.message));
  }, []);

  function editPlaybook(key, playbook) {
    const parsed = parsePlaybookSteps(playbook.steps || []);
    setEditingKey(key);
    setForm({
      key,
      title: playbook.title || "",
      category: playbook.category || "Custom",
      task: playbook.task || "",
      trigger: playbook.trigger || "",
      cadence: playbook.cadence || "",
      goal: playbook.goal || "",
      opening: parsed.opening,
      qualification: parsed.qualification,
      objectionHandling: parsed.objectionHandling,
      successCondition: parsed.successCondition,
      stopCondition: parsed.stopCondition,
      outcomeFields: parsed.outcomeFields || blankForm.outcomeFields,
      steps: parsed.steps.join("\n")
    });
    setFormOpen(true);
  }

  async function savePlaybook(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    try {
      const path = editingKey ? `/playbooks/${editingKey}` : "/playbooks";
      const method = editingKey ? "PUT" : "POST";
      await apiFetch(path, { method, body: JSON.stringify({ ...form, steps: buildPlaybookSteps(form) }) });
      setMessage(editingKey ? "Playbook updated." : "Playbook created.");
      setForm(blankForm);
      setEditingKey("");
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deletePlaybook(key) {
    if (!confirm("Deactivate this playbook? Existing campaign records will keep their playbook key.")) return;
    setError("");
    setMessage("");
    try {
      await apiFetch(`/playbooks/${key}`, { method: "DELETE" });
      setMessage("Playbook deactivated.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Shell>
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-black text-slate-950 sm:text-4xl">Playbooks</h1>
          <p className="mt-2 text-sm text-slate-500">Create and tune conversation flows for each lending workflow.</p>
        </div>
        <button onClick={() => { setFormOpen(!formOpen); setEditingKey(""); setForm(blankForm); }} className="btn">New Playbook</button>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

      {formOpen && (
        <form onSubmit={savePlaybook} className="card mt-8 grid grid-cols-1 gap-4 p-6 lg:grid-cols-2">
          <input className="input" placeholder="Key, e.g. RENEWAL_OFFER" value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} disabled={Boolean(editingKey)} />
          <input className="input" placeholder="Title" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required />
          <input className="input" placeholder="Category" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} />
          <input className="input" placeholder="Task" value={form.task} onChange={e => setForm({ ...form, task: e.target.value })} />
          <input className="input" placeholder="Trigger" value={form.trigger} onChange={e => setForm({ ...form, trigger: e.target.value })} />
          <input className="input" placeholder="Cadence" value={form.cadence} onChange={e => setForm({ ...form, cadence: e.target.value })} />
          <textarea className="input min-h-24 lg:col-span-2" placeholder="Goal" value={form.goal} onChange={e => setForm({ ...form, goal: e.target.value })} />
          <div className="lg:col-span-2">
            <div className="mb-3 grid grid-cols-2 gap-2 text-xs font-bold text-slate-500 sm:grid-cols-3 lg:grid-cols-6">
              {["Opening", "Qualification", "Objections", "Success", "Stop", "Outcome"].map(label => (
                <span key={label} className="rounded-lg bg-slate-50 px-3 py-2 text-center">{label}</span>
              ))}
            </div>
          </div>
          <textarea className="input min-h-20" placeholder="Opening line and consent check" value={form.opening} onChange={e => setForm({ ...form, opening: e.target.value })} />
          <textarea className="input min-h-20" placeholder="Qualification question or next best question" value={form.qualification} onChange={e => setForm({ ...form, qualification: e.target.value })} />
          <textarea className="input min-h-24 lg:col-span-2" placeholder="Objection handling: interest, fees, safety, callback, not interested" value={form.objectionHandling} onChange={e => setForm({ ...form, objectionHandling: e.target.value })} />
          <textarea className="input min-h-20" placeholder="Success condition, e.g. user agrees to open link" value={form.successCondition} onChange={e => setForm({ ...form, successCondition: e.target.value })} />
          <textarea className="input min-h-20" placeholder="Stop condition, e.g. opt-out, wrong number, voicemail" value={form.stopCondition} onChange={e => setForm({ ...form, stopCondition: e.target.value })} />
          <input className="input lg:col-span-2" placeholder="Outcome fields to capture" value={form.outcomeFields} onChange={e => setForm({ ...form, outcomeFields: e.target.value })} />
          <textarea className="input min-h-40 lg:col-span-2" placeholder="Additional conversation steps, one per line" value={form.steps} onChange={e => setForm({ ...form, steps: e.target.value })} />
          <button className="btn">{editingKey ? "Save Playbook" : "Create Playbook"}</button>
          <button type="button" onClick={() => { setFormOpen(false); setEditingKey(""); setForm(blankForm); }} className="btn-secondary">Cancel</button>
        </form>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Object.entries(playbooks).map(([key, playbook]) => (
          <div className="card p-6" key={key}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-widest text-sky-600">{playbook.category}</div>
                <h2 className="mt-3 text-xl font-black text-slate-950">{playbook.title}</h2>
                <p className="mt-1 text-xs text-slate-500">{key}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => editPlaybook(key, playbook)} className="btn-secondary">Edit</button>
                <button onClick={() => deletePlaybook(key)} className="btn-secondary">Delete</button>
              </div>
            </div>
            <p className="mt-4 text-sm text-slate-500">{playbook.goal}</p>
            <div className="mt-5 grid gap-2 text-sm">
              <div className="rounded-lg bg-slate-50 p-3"><span className="font-semibold text-slate-500">Task: </span>{playbook.task}</div>
              <div className="rounded-lg bg-slate-50 p-3"><span className="font-semibold text-slate-500">Trigger: </span>{playbook.trigger}</div>
              <div className="rounded-lg bg-slate-50 p-3"><span className="font-semibold text-slate-500">Cadence: </span>{playbook.cadence}</div>
            </div>
            <div className="mt-5 space-y-2">
              {(playbook.steps || []).map((step, index) => (
                <div key={`${key}-${index}`} className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{index + 1}. {step}</div>
              ))}
            </div>
          </div>
        ))}
        {!Object.keys(playbooks).length && <div className="card p-6 text-sm text-slate-500">No playbooks loaded.</div>}
      </div>
    </Shell>
  );
}

function buildPlaybookSteps(form) {
  const structured = [
    ["Opening", form.opening],
    ["Qualification", form.qualification],
    ["Objection handling", form.objectionHandling],
    ["Success condition", form.successCondition],
    ["Stop condition", form.stopCondition],
    ["Outcome fields", form.outcomeFields]
  ]
    .filter(([, value]) => String(value || "").trim())
    .map(([label, value]) => `${label}: ${String(value).trim()}`);
  const additional = String(form.steps || "")
    .split(/\r?\n/)
    .map(step => step.trim())
    .filter(Boolean);
  return [...structured, ...additional].join("\n");
}

function parsePlaybookSteps(steps) {
  const result = {
    opening: "",
    qualification: "",
    objectionHandling: "",
    successCondition: "",
    stopCondition: "",
    outcomeFields: "",
    steps: []
  };
  const prefixes = [
    ["Opening:", "opening"],
    ["Qualification:", "qualification"],
    ["Objection handling:", "objectionHandling"],
    ["Success condition:", "successCondition"],
    ["Stop condition:", "stopCondition"],
    ["Outcome fields:", "outcomeFields"]
  ];

  for (const step of steps) {
    const text = String(step || "").trim();
    const match = prefixes.find(([prefix]) => text.toLowerCase().startsWith(prefix.toLowerCase()));
    if (match) {
      result[match[1]] = text.slice(match[0].length).trim();
    } else if (text) {
      result.steps.push(text);
    }
  }
  return result;
}
