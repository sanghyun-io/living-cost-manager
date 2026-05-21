const isGithubPages = process.env.GITHUB_PAGES === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true
  },
  basePath: isGithubPages ? "/living-cost-manager" : undefined,
  assetPrefix: isGithubPages ? "/living-cost-manager/" : undefined
};

export default nextConfig;
