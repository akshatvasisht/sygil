import webpack from "next/dist/compiled/webpack/webpack-lib.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@sygil/shared"],
  experimental: {
    typedRoutes: false,
  },
  webpack: (config, { isServer }) => {
    // @sygil/shared uses ESM `.js` extension imports in its TypeScript source.
    // When transpilePackages pulls in raw .ts, webpack needs this mapping.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };

    // @sygil/shared's contract-validator.ts imports node:fs/promises and
    // node:path for resolveInputMapping() — a server-only function. The web UI
    // only uses types from @sygil/shared, so we strip the `node:` prefix and
    // stub the bare Node.js builtins for the client bundle.
    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        })
      );

      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        "fs/promises": false,
        path: false,
      };
    }

    return config;
  },
};

export default nextConfig;
