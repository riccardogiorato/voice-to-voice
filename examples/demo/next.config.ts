import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@together/realtime"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [{ key: "Permissions-Policy", value: "microphone=(self)" }],
    }];
  },
};

export default config;
