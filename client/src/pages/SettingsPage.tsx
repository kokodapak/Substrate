import { Layout } from '../components/Layout';

export function SettingsPage() {
  return (
    <Layout>
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-gray-100">Settings</h1>
        <p className="mt-2 text-gray-400">Configuration and preferences will appear here.</p>
      </div>
    </Layout>
  );
}
