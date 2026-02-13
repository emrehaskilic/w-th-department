import React, { useEffect, useMemo, useState } from 'react';
import LiveTelemetryDashboard from './LiveTelemetryDashboard';
import DryRunDashboard from './DryRunDashboard';

type AppTab = 'telemetry' | 'dry-run';

function tabFromHash(hash: string): AppTab {
  return hash === '#dry-run' ? 'dry-run' : 'telemetry';
}

const Dashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AppTab>(() => tabFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => {
      setActiveTab(tabFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const tabs = useMemo<Array<{ id: AppTab; label: string }>>(() => ([
    { id: 'telemetry', label: 'Live Telemetry' },
    { id: 'dry-run', label: 'Dry Run' },
  ]), []);

  const setTab = (tab: AppTab) => {
    setActiveTab(tab);
    const hash = tab === 'dry-run' ? '#dry-run' : '#telemetry';
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-200">
      <div className="sticky top-0 z-20 border-b border-zinc-800 bg-[#09090b]/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="text-xs tracking-[0.2em] uppercase text-zinc-500">Orderflow Control Surface</div>
          <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-1 gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setTab(tab.id)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  activeTab === tab.id
                    ? 'bg-zinc-200 text-zinc-900 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activeTab === 'dry-run' ? <DryRunDashboard /> : <LiveTelemetryDashboard />}
    </div>
  );
};

export default Dashboard;
