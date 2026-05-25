import Shell from "../../components/Shell";

const playbooks = [
  ["Soft Payment Reminder", "Collection", "Pay early, preserve CIBIL, reduce interest/fees."],
  ["Hard Payment Reminder", "Collection", "Missed due date, penalty awareness, repayment promise."],
  ["Unapproved Users", "Retargeting", "Eligibility check, doc upload, route to support."],
  ["Approved Users", "Retargeting", "Offer expiry, reason capture, continue process."],
  ["Fresh Lead", "Targeting", "Cold calling, requirement capture, eligibility link."]
];

export default function Playbooks() {
  return (
    <Shell>
      <h1 className="text-4xl font-black">Playbooks</h1>
      <p className="mt-2 text-zinc-400">Controlled conversation flows keep quality high and cost low.</p>

      <div className="mt-8 grid grid-cols-2 gap-4">
        {playbooks.map(([name, type, desc]) => (
          <div className="card p-6" key={name}>
            <div className="text-xs uppercase tracking-widest text-blue-400">{type}</div>
            <h2 className="mt-3 text-xl font-bold">{name}</h2>
            <p className="mt-2 text-sm text-zinc-400">{desc}</p>
            <button className="btn-secondary mt-5">Configure</button>
          </div>
        ))}
      </div>
    </Shell>
  );
}
