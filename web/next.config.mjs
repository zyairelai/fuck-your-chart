const isGithubActions = Boolean(process.env.GITHUB_ACTIONS);
let repoName = "";
if (isGithubActions && process.env.GITHUB_REPOSITORY) {
  repoName = process.env.GITHUB_REPOSITORY.split("/")[1] || "";
}
const isUserOrOrgPage = repoName.toLowerCase().endsWith(".github.io");
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? (repoName && !isUserOrOrgPage ? `/${repoName}` : "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pure static export for GitHub Pages / static hosting or Docker
  output: "export",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
