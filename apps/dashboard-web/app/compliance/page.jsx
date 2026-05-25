import Shell from "../../components/Shell";

export default function Compliance() {
  const items = ["Call window: 9 AM – 8 PM", "Max attempts: 3", "DNC check enabled", "No OTP/PIN/password policy", "AI disclosure configurable"];
  return (
    <Shell>
      <h1 className="text-4xl font-black">Compliance</h1>
      <p className="mt-2 text-zinc-400">BFSI guardrails enforced outside the AI layer.</p>

      <div className="card mt-8 p-6">
        {items.map(i => <div key={i} className="border-b border-white/10 py-4 text-sm">{i}</div>)}
      </div>
    </Shell>
  );
}
