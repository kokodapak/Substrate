import { Layout } from '../components/Layout';

export function TimelinePage() {
  return (
    <Layout>
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-gray-100">State Timeline</h1>
        <p className="mt-2 text-gray-400">Event history and state changes will appear here.</p>
      </div>
    </Layout>
  );
}
