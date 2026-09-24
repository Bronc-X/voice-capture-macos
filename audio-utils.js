(function registerVoiceAudioUtils(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.VOICE_AUDIO_UTILS = api;
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  function dbfs(amplitude) {
    if (!Number.isFinite(amplitude) || amplitude <= 0) return -Infinity;
    return 20 * Math.log10(amplitude);
  }

  function flattenChunks(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Float32Array(totalLength);
    let cursor = 0;
    chunks.forEach((chunk) => {
      result.set(chunk, cursor);
      cursor += chunk.length;
    });
    return result;
  }

  function resampleLinear(samples, sourceRate, targetRate) {
    if (sourceRate === targetRate) return samples;
    const targetLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
    const output = new Float32Array(targetLength);
    const ratio = (samples.length - 1) / Math.max(1, targetLength - 1);
    for (let index = 0; index < targetLength; index += 1) {
      const sourcePosition = index * ratio;
      const left = Math.floor(sourcePosition);
      const right = Math.min(samples.length - 1, left + 1);
      const fraction = sourcePosition - left;
      output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
    return output;
  }

  function analyzeSamples(samples, sampleRate) {
    let peak = 0;
    let sumSquares = 0;
    let clippingSamples = 0;
    let nearSilenceSamples = 0;
    let dcSum = 0;

    for (const sample of samples) {
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      sumSquares += sample * sample;
      dcSum += sample;
      if (absolute >= 0.999) clippingSamples += 1;
      if (absolute < 0.003) nearSilenceSamples += 1;
    }

    const safeLength = Math.max(1, samples.length);
    const rms = Math.sqrt(sumSquares / safeLength);
    return {
      peak,
      peakDbfs: dbfs(peak),
      rms,
      rmsDbfs: dbfs(rms),
      clippingRatio: clippingSamples / safeLength,
      nearSilenceRatio: nearSilenceSamples / safeLength,
      dcOffset: dcSum / safeLength,
      durationSeconds: samples.length / sampleRate
    };
  }

  function gradeTake(metrics, expectedSeconds) {
    const notes = [];
    let level = "good";
    let label = "质量通过";

    if (metrics.durationSeconds < Math.max(4, expectedSeconds * 0.38)) {
      level = "bad";
      label = "建议重录";
      notes.push("时长明显短于采集稿，可能漏读或抢读。 ");
    }
    if (metrics.clippingRatio > 0.0005 || metrics.peakDbfs > -0.25) {
      level = "bad";
      label = "建议重录";
      notes.push("检测到削波风险，请降低增益或离麦克风稍远。 ");
    } else if (metrics.clippingRatio > 0 || metrics.peakDbfs > -1.5) {
      if (level === "good") level = "warning";
      if (label === "质量通过") label = "可用但需复听";
      notes.push("峰值较高，爆破音处可能失真。 ");
    }
    if (metrics.peakDbfs < -22 || metrics.rmsDbfs < -34) {
      if (level === "good") level = "warning";
      if (label === "质量通过") label = "音量偏低";
      notes.push("整体电平偏低，请靠近麦克风或适当提高输入增益。 ");
    }
    if (metrics.nearSilenceRatio > 0.62) {
      if (level === "good") level = "warning";
      if (label === "质量通过") label = "停顿偏多";
      notes.push("静音占比较高，请确认没有长时间停顿或断音。 ");
    }
    if (Math.abs(metrics.dcOffset) > 0.02) {
      if (level === "good") level = "warning";
      if (label === "质量通过") label = "波形需检查";
      notes.push("检测到较明显直流偏移，后期需要清理。 ");
    }
    if (notes.length === 0) {
      notes.push("电平与时长处于建议范围。请仍然复听口误、环境声、喷麦和混响。 ");
    }
    return { level, label, notes };
  }

  function floatToPcm16(samples) {
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
    return pcm;
  }

  function encodeWavPcm16(pcm, sampleRate) {
    const bytesPerSample = 2;
    const dataLength = pcm.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeAscii = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (const sample of pcm) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  return {
    dbfs,
    flattenChunks,
    resampleLinear,
    analyzeSamples,
    gradeTake,
    floatToPcm16,
    encodeWavPcm16
  };
});
