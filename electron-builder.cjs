"use strict";

// An ad-hoc build is runnable but is NOT a Developer ID / notarized release.
const signed = process.env.MAC_SIGNED === "1";
if (signed && (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD ||
    !process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID)) {
  throw new Error("Signed builds require the documented Apple signing and notarization secrets.");
}

module.exports = {
  appId: "com.broncx.voicecapture",
  productName: "Voice Capture",
  asar: true,
  directories: { output: "dist", buildResources: "build" },
  files: ["index.html", "styles.css", "scripts.js", "audio-utils.js", "app.js", "desktop/*.cjs"],
  artifactName: "Voice-Capture-${version}-macOS-${arch}.${ext}",
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }],
    category: "public.app-category.music",
    minimumSystemVersion: "14.0",
    identity: signed ? undefined : "-",
    hardenedRuntime: signed,
    notarize: signed,
    forceCodeSigning: signed,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    extendInfo: {
      CFBundleDisplayName: "声线采样室",
      NSMicrophoneUsageDescription: "用于录制你本人授权的声音。音频仅在本机处理，不会自动上传。"
    }
  },
  dmg: {
    title: "Voice Capture",
    contents: [
      { x: 140, y: 180, type: "file" },
      { x: 420, y: 180, type: "link", path: "/Applications" }
    ],
    window: { width: 560, height: 360 }
  }
};
