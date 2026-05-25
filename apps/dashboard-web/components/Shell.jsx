import Link from "next/link";
import { BarChart3, Bot, FileUp, LayoutDashboard, PhoneCall, ShieldCheck } from "lucide-react";

const nav = [
  ["Dashboard", "/", LayoutDashboard],
  ["Campaigns", "/campaigns", PhoneCall],
  ["Playbooks", "/playbooks", Bot],
  ["Upload Leads", "/upload", FileUp],
  ["Analytics", "/analytics", BarChart3],
  ["Compliance", "/compliance", ShieldCheck]
];

export default function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#05070b]">
      <aside className="fixed inset-y-0 left-0 w-72 border-r border-white/10 bg-black/40 p-6">
        <div className="text-2xl font-black tracking-tight">LoanConnect<span className="text-blue-500">AI</span></div>
        <p className="mt-2 text-xs text-zinc-500">BFSI voice operations console</p>
        <nav className="mt-10 space-y-2">
          {nav.map(([label, href, Icon]) => (
            <Link key={href} href={href} className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-zinc-300 hover:bg-white/[0.06] hover:text-white">
              <Icon size={18} /> {label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="ml-72 min-h-screen p-8">{children}</main>
    </div>
  );
}
