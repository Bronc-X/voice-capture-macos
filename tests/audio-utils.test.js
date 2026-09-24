"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  resampleLinear,
  gradeTake,
  encodeWavPcm16
} = require("../audio-utils.js");

function readAscii(view, offset, length) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

test("resampleLinear keeps duration, length, and endpoints", () => {
  const source = new Float32Array([0, 1]);
  const output = resampleLinear(source, 2, 4);

  assert.equal(output.length, 4);
  assert.equal(output[0], 0);
  assert.ok(Math.abs(output[1] - 1 / 3) < 1e-6);
  assert.ok(Math.abs(output[2] - 2 / 3) < 1e-6);
  assert.equal(output[3], 1);
  assert.strictEqual(resampleLinear(source, 48000, 48000), source);
});

test("encodeWavPcm16 writes a valid mono 48 kHz PCM header and samples", async () => {
  const pcm = new Int16Array([-32768, -1, 0, 1, 32767]);
  const wav = encodeWavPcm16(pcm, 48000);
  const view = new DataView(await wav.arrayBuffer());

  assert.equal(wav.type, "audio/wav");
  assert.equal(wav.size, 44 + pcm.byteLength);
  assert.equal(readAscii(view, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + pcm.byteLength);
  assert.equal(readAscii(view, 8, 4), "WAVE");
  assert.equal(readAscii(view, 12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 96000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(readAscii(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), pcm.byteLength);
  assert.deepEqual(
    Array.from({ length: pcm.length }, (_, index) => view.getInt16(44 + index * 2, true)),
    Array.from(pcm)
  );
});

test("gradeTake distinguishes passing, warning, and reject conditions", () => {
  const passingMetrics = {
    durationSeconds: 12,
    clippingRatio: 0,
    peakDbfs: -6,
    rmsDbfs: -18,
    nearSilenceRatio: 0.2,
    dcOffset: 0
  };

  const passing = gradeTake(passingMetrics, 12);
  assert.equal(passing.level, "good");
  assert.equal(passing.label, "质量通过");

  const warning = gradeTake({ ...passingMetrics, peakDbfs: -1, clippingRatio: 0.0001 }, 12);
  assert.equal(warning.level, "warning");
  assert.equal(warning.label, "可用但需复听");

  const rejected = gradeTake({ ...passingMetrics, durationSeconds: 2, peakDbfs: -0.1 }, 12);
  assert.equal(rejected.level, "bad");
  assert.equal(rejected.label, "建议重录");
  assert.ok(rejected.notes.some((note) => note.includes("时长明显短")));
  assert.ok(rejected.notes.some((note) => note.includes("削波风险")));
});

test("app delegates DSP helpers to window.VOICE_AUDIO_UTILS", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const helperNames = [
    "dbfs",
    "flattenChunks",
    "resampleLinear",
    "analyzeSamples",
    "gradeTake",
    "floatToPcm16",
    "encodeWavPcm16"
  ];

  assert.match(appSource, /window\.VOICE_AUDIO_UTILS/);
  helperNames.forEach((name) => {
    assert.doesNotMatch(appSource, new RegExp(`function\\s+${name}\\s*\\(`));
  });
});
