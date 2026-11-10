import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  /*
   * Phones on the local network load the dev server from the PC's LAN address,
   * which Next treats as a different origin from localhost.
   */
  allowedDevOrigins: ["192.168.0.*", "192.168.1.*"],
};

export default nextConfig;