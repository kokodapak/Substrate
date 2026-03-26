import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/overview', label: 'Overview' },
  { to: '/remediation', label: 'Remediation Queue' },
  { to: '/access', label: 'Access Control' },
  { to: '/timeline', label: 'Timeline' },
  { to: '/settings', label: 'Settings' },
  { to: '/federation', label: 'Federation' },
  { to: '/rule-registry', label: 'Rule Registry' },
];

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-5 py-5 border-b border-gray-800">
          <span className="text-sm font-semibold tracking-widest text-gray-400 uppercase">
            Substrate
          </span>
        </div>
        <nav className="flex-1 py-4 px-3 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [
                  'flex items-center px-3 py-2 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-gray-800 text-white font-medium'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-950">{children}</main>
    </div>
  );
}
