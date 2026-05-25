import Shell from "../../components/Shell";

export default function Analytics() {
  return (
    <Shell>
      <h1 className="text-4xl font-black">Analytics</h1>
      <p className="mt-2 text-zinc-400">Track pickup, recovery, cost and playbook performance.</p>

      <div className="mt-8 grid grid-cols-3 gap-4">
        <div className="card p-6"><p className="text-zinc-500">Pickup Rate</p><p className="mt-3 text-4xl font-black">62%</p></div>
        <div className="card p-6"><p className="text-zinc-500">Recovery Rate</p><p className="mt-3 text-4xl font-black">18%</p></div>
        <div className="card p-6"><p className="text-zinc-500">Avg Cost</p><p className="mt-3 text-4xl font-black">₹2.4/min</p></div>
      </div>
    </Shell>
  );
}
