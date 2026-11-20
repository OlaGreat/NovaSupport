import { AppShell } from "@/components/app-shell";

export default function DashboardLoading() {
  return (
    <AppShell>
      <div className="animate-pulse space-y-4 p-8 max-w-4xl mx-auto">
        <div className="h-6 w-1/3 rounded bg-white/10" />
        {/* Mirror the page's 4 summary stat cards to avoid a layout shift. */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} data-testid="stat-card-skeleton" className="h-24 rounded bg-white/10" />
          ))}
        </div>
        <div className="h-64 rounded bg-white/10" />
      </div>
    </AppShell>
  );
}
