import Shell from "../../components/Shell";

export default function Upload() {
  return (
    <Shell>
      <h1 className="text-4xl font-black">Upload Leads</h1>
      <p className="mt-2 text-zinc-400">CSV format: name, phone, campaignType, playbookType, dropStage, dueDate, loanAmount, offerAmount, language</p>

      <div className="card mt-8 p-8">
        <label className="block text-sm text-zinc-400">Choose CSV file</label>
        <input className="input mt-3" type="file" />
        <button className="btn mt-5">Upload Leads</button>
      </div>
    </Shell>
  );
}
