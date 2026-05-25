import Shell from "../components/Shell";

export default function Dashboard() {
  const cards = [
    ["Active Campaigns", "5", "+2 this week"],
    ["Queued Calls", "1,284", "BullMQ ready"],
    ["Connect Rate", "63%", "last 7 days"],
    ["Cost / Min", "₹2.4", "SarvamAI optimized"]
  ];

  return (
    <Shell>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-4xl font-black">Operations Dashboard</h1>
          <p className="mt-2 text-zinc-400">Cold calling, collections and retargeting workflows in one place.</p>
        </div>
        <button className="btn">Create Campaign</button>
      </div>

      <section className="mt-8 grid grid-cols-4 gap-4">
        {cards.map(([a,b,c]) => (
          <div className="card p-5" key={a}>
            <p className="text-sm text-zinc-500">{a}</p>
            <p className="mt-3 text-4xl font-black">{b}</p>
            <p className="mt-2 text-xs text-zinc-500">{c}</p>
          </div>
        ))}
      </section>

      <section className="mt-8 grid grid-cols-3 gap-4">
        <div className="card p-6">
          <h2 className="text-lg font-bold">Targeting</h2>
          <p className="mt-2 text-sm text-zinc-400">Cold calling fresh leads from database.</p>
          <div className="mt-5 rounded-xl bg-blue-500/10 p-4 text-sm text-blue-200">Fresh Lead Playbook</div>
        </div>
        <div className="card p-6">
          <h2 className="text-lg font-bold">Collection</h2>
          <p className="mt-2 text-sm text-zinc-400">Soft and hard payment reminders.</p>
          <div className="mt-5 space-y-2">
            <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">Soft Reminder</div>
            <div className="rounded-xl bg-red-500/10 p-3 text-sm text-red-200">Hard Reminder</div>
          </div>
        </div>
        <div className="card p-6">
          <h2 className="text-lg font-bold">Retargeting</h2>
          <p className="mt-2 text-sm text-zinc-400">Bring back unapproved and approved users.</p>
          <div className="mt-5 space-y-2">
            <div className="rounded-xl bg-purple-500/10 p-3 text-sm text-purple-200">Unapproved Users</div>
            <div className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200">Approved Users</div>
          </div>
        </div>
      </section>
    </Shell>
  );
}
