import Link from "next/link";
import LiveDashboard from "./LiveDashboard.js";

export const dynamic = "force-dynamic";

export default function LivePage() {
  return (
    <main className="dashboard-shell live-shell">
      <header className="dashboard-header detail-header live-header">
        <div>
          <Link className="back-link" href="/">Back to dashboard</Link>
          <p className="eyebrow">BTCUSDT 5 minute collector</p>
          <h1>Live latest market</h1>
        </div>
      </header>
      <LiveDashboard />
    </main>
  );
}
