const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

let application;
let page;
let temporary;
let errors;

test.beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "voice-capture-test-"));
  const executable = process.env.VOICE_CAPTURE_EXECUTABLE;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // A packaged application must work without finding Node, Python or a browser in PATH.
  if (executable) env.PATH = "";
  application = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [
      ...(executable ? [] : [path.resolve(__dirname, "../..")]),
      `--user-data-dir=${path.join(temporary, "profile")}`,
      "--use-fake-device-for-media-stream"
    ],
    env
  });
  page = await application.firstWindow();
  // Electron owns beforeunload via its native confirmation. Prevent Playwright
  // from trying to dismiss a Chromium dialog that Electron has already handled.
  page.on("dialog", () => {});
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("#segmentId")).toHaveText("S01");
});

test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  expect(errors).toEqual([]);
});

async function connect() {
  await page.locator("#consentCheckbox").check();
  await page.locator("#connectMicBtn").click();
  await expect(page.locator("#micState")).toContainText("已连接");
  await expect(page.locator("#recordBtn")).toBeEnabled();
}

async function record(milliseconds = 300) {
  await page.locator("#recordBtn").click();
  await expect(page.locator("#stopBtn")).toBeEnabled();
  await page.waitForTimeout(milliseconds); // Collect real Web Audio callbacks from Chromium's fake microphone.
  await page.locator("#stopBtn").click();
  await expect(page.locator("#takeResult")).toBeVisible();
}

async function saveTo(filename) {
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, filename);
}

test("offline recording, playback, 18-segment WAV/JSON export, and close protection", async () => {
  expect(await page.evaluate(() => typeof window.require)).toBe("undefined");
  await expect(page.locator("#recordBtn")).toBeDisabled();
  await expect(page.locator("#exportAudioBtn")).toBeDisabled();
  expect(await page.evaluate(() => fetch("https://example.com").then(() => false, () => true))).toBe(true);
  await connect();
  await record(1600);
  const preview = await page.locator("#takePreview").evaluate(async (audio) => {
    await audio.play();
    const result = { duration: audio.duration, playing: !audio.paused };
    audio.pause();
    return result;
  });
  expect(preview.duration).toBeGreaterThan(1);
  expect(preview.playing).toBe(true);
  const singlePath = path.join(temporary, "single.wav");
  await saveTo(singlePath);
  await page.locator("#downloadTakeBtn").click();
  await expect(page.locator("#exportStatus")).toContainText("本段 WAV 已保存");
  const single = await fs.readFile(singlePath);
  expect(single.toString("ascii", 0, 4)).toBe("RIFF");
  expect(single.readUInt32LE(24)).toBe(48000);
  expect(single.readUInt16LE(22)).toBe(1);
  expect(single.readUInt16LE(34)).toBe(16);
  expect(single.subarray(44).some((byte) => byte !== 0)).toBe(true);
  await page.locator("#acceptBtn").click();
  for (let i = 1; i < 18; i++) {
    await record();
    await page.locator("#acceptBtn").click();
  }
  await expect(page.locator("#progressFraction")).toHaveText("18 / 20");
  const wavPath = path.join(temporary, "combined.wav");
  await saveTo(wavPath);
  await page.locator("#exportAudioBtn").click();
  await expect(page.locator("#exportStatus")).toContainText("合并 WAV 已导出");
  const jsonPath = path.join(temporary, "manifest.json");
  await saveTo(jsonPath);
  await page.locator("#exportManifestBtn").click();
  await expect(page.locator("#exportStatus")).toContainText("质量清单已导出");
  const manifest = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const wav = await fs.readFile(wavPath);
  expect(manifest.output.acceptedSegmentCount).toBe(18);
  expect(manifest.segments.map((segment) => segment.segmentId)).toEqual(Array.from({ length: 18 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`));
  expect(manifest.recordingEnvironment).toBe("local_desktop_no_automatic_upload");
  expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  expect((wav.length - 44) / 96000).toBeCloseTo(manifest.output.totalDurationSeconds, 5);
  for (let i = 1; i < manifest.segments.length; i++) {
    expect(manifest.segments[i].startSeconds - manifest.segments[i - 1].endSeconds).toBeCloseTo(0.75, 5);
  }
  await application.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect(page.locator("#progressFraction")).toHaveText("18 / 20");
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test("cancelled and failed saves preserve the take and allow retry", async () => {
  await connect();
  await record();
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await page.locator("#downloadTakeBtn").click();
  await expect(page.locator("#exportStatus")).toContainText("已取消保存");
  await expect(page.locator("#takeResult")).toBeVisible();
  await saveTo(path.join(temporary, "missing-directory", "failed.wav"));
  await page.locator("#downloadTakeBtn").click();
  await expect(page.locator("#exportStatus")).toContainText("保存失败");
  await expect(page.locator("#downloadTakeBtn")).toBeEnabled();
  await saveTo(path.join(temporary, "retry.wav"));
  await page.locator("#downloadTakeBtn").click();
  await expect(page.locator("#exportStatus")).toContainText("本段 WAV 已保存");
  expect((await fs.stat(path.join(temporary, "retry.wav"))).size).toBeGreaterThan(44);
});

test("permission denial provides recovery guidance and the app can reconnect", async () => {
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("voice:microphone");
    ipcMain.handle("voice:microphone", () => false);
  });
  await page.locator("#consentCheckbox").check();
  await page.locator("#connectMicBtn").click();
  await expect(page.locator("#micHelp")).toBeVisible();
  await expect(page.locator("#recordBtn")).toBeDisabled();
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("voice:microphone");
    ipcMain.handle("voice:microphone", () => true);
  });
  await page.locator("#connectMicBtn").click();
  await expect(page.locator("#recordBtn")).toBeEnabled();
  await expect(page.locator("#micHelp")).toBeHidden();
});
