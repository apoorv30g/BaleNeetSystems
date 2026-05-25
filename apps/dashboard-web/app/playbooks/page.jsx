"use client";

import Shell from "../../components/Shell";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

export default function Playbooks() {
  const [playbooks, setPlaybooks] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/campaigns/playbooks").then(setPlaybooks).catch(err => setError(err.message));
  }, []);

  return (
    <Shell>
      <h1 className="text-4xl font-black">Playbooks</h1>
      <p className="mt-2 text-zinc-400">Controlled conversation flows keep quality high and cost low.</p>
      {error && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <div className="mt-8 grid grid-cols-2 gap-4">
        {Object.entries(playbooks).map(([key, playbook]) => (
          <div className="card p-6" key={key}>
            <div className="text-xs uppercase tracking-widest text-blue-400">{playbook.category}</div>
            <h2 className="mt-3 text-xl font-bold">{playbook.title}</h2>
            <p className="mt-2 text-sm text-zinc-400">{playbook.goal}</p>
            <div className="mt-5 grid gap-2 text-sm">
              <div className="rounded-xl bg-white/[0.04] p-3">
                <span className="text-zinc-500">Task: </span>{playbook.task}
              </div>
              <div className="rounded-xl bg-white/[0.04] p-3">
                <span className="text-zinc-500">Trigger: </span>{playbook.trigger}
              </div>
              <div className="rounded-xl bg-white/[0.04] p-3">
                <span className="text-zinc-500">Cadence: </span>{playbook.cadence}
              </div>
            </div>
            <div className="mt-5 space-y-2">
              {playbook.steps.map((step, index) => (
                <div key={step} className="rounded-xl bg-white/[0.04] p-3 text-sm text-zinc-300">{index + 1}. {step}</div>
              ))}
            </div>
          </div>
        ))}
        {!Object.keys(playbooks).length && <div className="card p-6 text-sm text-zinc-500">No playbooks loaded.</div>}
      </div>
    </Shell>
  );
}
