import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // Pin the workspace root so a stray lockfile higher up the tree isn't picked up.
  outputFileTracingRoot: path.join(__dirname),
  turbopack: { root: path.join(__dirname) },
  // Cross-origin isolation lets the in-browser AI voice (ONNX runtime) use multiple CPU threads,
  // which makes it several times faster. "credentialless" keeps third-party map tiles and photos
  // loading without them needing special headers (Chrome/Edge; other browsers just run slower).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
    ];
  },
};

export default nextConfig;
