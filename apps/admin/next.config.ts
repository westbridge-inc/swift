import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@swift/types'],
};

export default nextConfig;
