import { Layout } from '../components/Layout';

export function RemediationPage() {
  return (
    <Layout>
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-gray-100">Remediation Queue</h1>
        <p className="mt-2 text-gray-400">Agent task queue and remediation actions will appear here.</p>
      </div>
    </Layout>
  );
}
