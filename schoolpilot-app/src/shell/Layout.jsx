import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50">
      <Header onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main content - offset by sidebar on desktop */}
      <main className="lg:ml-60 min-h-[calc(100vh-3.5rem)] pb-16 lg:pb-0">
        <div className="mx-auto max-w-7xl p-4 sm:p-6">
          <Outlet />
        </div>
      </main>

      <BottomNav />
    </div>
  );
}
