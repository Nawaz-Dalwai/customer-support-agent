/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the AWS SDK out of the server bundle and load it from node_modules at runtime
  // (replaces the original experimental.serverComponentsExternalPackages + webpack externals).
  serverExternalPackages: ["@aws-sdk/client-bedrock-agent-runtime"],
};

export default nextConfig;
