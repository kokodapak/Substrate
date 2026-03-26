import { Layout } from '../components/Layout';

export function OverviewPage() {
  return (
    <Layout>
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-gray-100">System Overview</h1>
        <p className="mt-2 text-gray-400">System state and metrics will appear here.</p>
      </div>
    </Layout>
  );
}
