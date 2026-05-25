import Shell from "../../components/Shell";

export default function Campaigns() {
  const campaigns = [
    ["KYC Recovery", "Retargeting", "Unapproved Users", "Active", "12,400"],
    ["Soft EMI Reminder", "Collection", "Soft Payment Reminder", "Active", "4,200"],
    ["Approved Offer Expiry", "Retargeting", "Approved Users", "Draft", "1,800"]
  ];

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-black">Campaigns</h1>
          <p className="mt-2 text-zinc-400">Create use-case specific voice campaigns.</p>
        </div>
        <button className="btn">New Campaign</button>
      </div>

      <div className="card mt-8 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.04] text-left text-zinc-400">
            <tr>
              <th className="p-4">Campaign</th>
              <th>Type</th>
              <th>Playbook</th>
              <th>Status</th>
              <th>Leads</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map(row => (
              <tr key={row[0]} className="border-t border-white/10">
                {row.map(cell => <td key={cell} className="p-4">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
