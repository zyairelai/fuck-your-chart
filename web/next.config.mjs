/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pure static export — no Node server needed at runtime, just static HTML.
  // Express serves the exported files; the Socket.IO data is what makes it
  // come alive in the browser.
  output: "export",
  // Don't fail the build on lint during docker build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
