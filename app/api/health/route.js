import { getDashboardData } from "@/lib/dashboardData.js";

export async function GET() {
  const data = await getDashboardData();

  return Response.json({
    ok: data.ok,
    configured: data.configured,
    error: data.error,
    heartbeat: data.heartbeat,
    stats: data.stats,
  });
}
