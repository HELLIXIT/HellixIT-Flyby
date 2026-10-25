'use client';

import dynamic from 'next/dynamic';

// Leaflet touches `window`, so the map app is rendered on the client only.
const FlybyApp = dynamic(() => import('./FlybyApp'), {
  ssr: false,
  loading: () => (
    <div className="boot">
      <div className="boot-plane">✈</div>
      <p>Loading live skies…</p>
    </div>
  ),
});

export default function ClientApp() {
  return <FlybyApp />;
}
