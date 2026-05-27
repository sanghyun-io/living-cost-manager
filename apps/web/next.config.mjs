/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export deployed to Cloudflare Pages at the domain root
  // (living-cost-manager.gamja.top), so no basePath/assetPrefix is needed.
  output: "export",
  images: {
    unoptimized: true
  }
};

export default nextConfig;
