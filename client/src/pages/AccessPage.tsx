import { Layout } from '../components/Layout';

export function AccessPage() {
  return (
    <Layout>
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-gray-100">Access Control</h1>
        <p className="mt-2 text-gray-400">Botignore and botinclude rules will appear here.</p>
      </div>
    </Layout>
  );
}
