/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  webpack: (config) => {
    // Required for @solana/web3.js
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      os: false,
      path: false,
      crypto: false,
    };
    // wagmi connectors reference optional peer deps that may not be installed
    config.resolve.alias = {
      ...config.resolve.alias,
      "porto/internal": false,
      porto: false,
      "@base-org/account": false,
    };
    return config;
  },
};

module.exports = nextConfig;
