const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(__dirname, "..");
const launcher = path.join(appRoot, "start_voice_capture.cmd");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.once("error", reject);
    request.setTimeout(500, () => request.destroy(new Error("request timed out")));
  });
}

async function waitForApp(url) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await requestText(url);
      if (response.statusCode === 200 && response.body.includes("声线采样室")) {
        return;
      }
    } catch {
      // The child server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`test server did not become ready: ${url}`);
}

test("double-click launcher reuses a healthy local app server", { skip: process.platform !== "win32" }, async () => {
  assert.ok(fs.existsSync(launcher), "start_voice_capture.cmd must exist for double-click launch");

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn(
    "python",
    ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
    { cwd: appRoot, windowsHide: true, stdio: "ignore" },
  );

  try {
    await waitForApp(url);
    const { stdout, stderr } = await execFileAsync(
      "cmd.exe",
      ["/d", "/c", launcher, "-Port", String(port), "-NoBrowser", "-NoWait"],
      { cwd: appRoot, windowsHide: true, timeout: 10000 },
    );
    assert.match(`${stdout}\n${stderr}`, /VOICE_CAPTURE_ALREADY_RUNNING/);

    const response = await requestText(url);
    assert.equal(response.statusCode, 200, "existing server must remain available");
    assert.match(response.body, /声线采样室/);
  } finally {
    server.kill();
  }
});
