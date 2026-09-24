(() => {
  "use strict";

  const project = window.VOICE_CAPTURE_SCRIPT;
  if (!project || !Array.isArray(project.segments)) {
    throw new Error("声音采集稿未加载。请确认 scripts.js 与 index.html 位于同一目录。 ");
  }

  const audioUtils = window.VOICE_AUDIO_UTILS;
  if (!audioUtils) {
    throw new Error("音频处理工具未加载。请确认 audio-utils.js 在 app.js 之前加载。 ");
  }
  const {
    dbfs,
    flattenChunks,
    resampleLinear,
    analyzeSamples,
    gradeTake,
    floatToPcm16,
    encodeWavPcm16
  } = audioUtils;

  const TARGET_SAMPLE_RATE = 48000;
  const desktop = window.voiceDesktop;
  const EXPORT_MIN_SEGMENTS = Math.max(1, project.segments.length - 2);
  const INTER_SEGMENT_SILENCE_SECONDS = 0.75;

  const elements = {
    consent: document.querySelector("#consentCheckbox"),
    connect: document.querySelector("#connectMicBtn"),
    micHelp: document.querySelector("#micHelp"),
    record: document.querySelector("#recordBtn"),
    recordLabel: document.querySelector("#recordBtnLabel"),
    stop: document.querySelector("#stopBtn"),
    retake: document.querySelector("#retakeBtn"),
    accept: document.querySelector("#acceptBtn"),
    downloadTake: document.querySelector("#downloadTakeBtn"),
    previous: document.querySelector("#prevBtn"),
    next: document.querySelector("#nextBtn"),
    exportAudio: document.querySelector("#exportAudioBtn"),
    exportManifest: document.querySelector("#exportManifestBtn"),
    segmentRail: document.querySelector("#segmentRail"),
    progressFraction: document.querySelector("#progressFraction"),
    progressFill: document.querySelector("#progressFill"),
    recordedDuration: document.querySelector("#recordedDuration"),
    segmentId: document.querySelector("#segmentId"),
    segmentIntent: document.querySelector("#segmentIntent"),
    segmentEstimate: document.querySelector("#segmentEstimate"),
    promptText: document.querySelector("#promptText"),
    deliveryNote: document.querySelector("#deliveryNote"),
    navStatus: document.querySelector("#navStatus"),
    micState: document.querySelector("#micState"),
    liveDb: document.querySelector("#liveDb"),
    levelFill: document.querySelector("#levelFill"),
    takeResult: document.querySelector("#takeResult"),
    takePreview: document.querySelector("#takePreview"),
    qualityBadge: document.querySelector("#qualityBadge"),
    qualityNote: document.querySelector("#qualityNote"),
    metricDuration: document.querySelector("#metricDuration"),
    metricPeak: document.querySelector("#metricPeak"),
    metricRms: document.querySelector("#metricRms"),
    metricClipping: document.querySelector("#metricClipping"),
    exportStatus: document.querySelector("#exportStatus"),
    toast: document.querySelector("#toast")
  };

  const state = {
    currentIndex: 0,
    stream: null,
    audioContext: null,
    sourceNode: null,
    analyserNode: null,
    processorNode: null,
    silentGainNode: null,
    meterFrame: null,
    isRecording: false,
    isConnecting: false,
    isSaving: false,
    exportStamp: null,
    recordingChunks: [],
    recordingStartedAt: null,
    currentTake: null,
    accepted: new Map(),
    previewUrl: null,
    toastTimer: null
  };

  function pad(value, length = 2) {
    return String(value).padStart(length, "0");
  }

  function formatDuration(seconds) {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = Math.floor(safeSeconds % 60);
    return `${pad(minutes)}:${pad(remainder)}`;
  }

  function formatDb(value) {
    if (!Number.isFinite(value)) return "−∞ dBFS";
    return `${value.toFixed(1).replace("-", "−")} dBFS`;
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 3600);
  }

  function setMicState(label, status) {
    elements.micState.textContent = label;
    elements.micState.dataset.state = status;
  }

  function revokePreviewUrl() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
  }

  function setPreview(take) {
    revokePreviewUrl();
    state.previewUrl = URL.createObjectURL(take.blob);
    elements.takePreview.src = state.previewUrl;
    elements.takePreview.load();
  }

  function buildRail() {
    elements.segmentRail.replaceChildren();
    project.segments.forEach((segment, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const id = document.createElement("span");
      const label = document.createElement("span");
      const check = document.createElement("span");

      id.className = "rail-id";
      id.textContent = segment.id;
      label.className = "rail-name";
      label.textContent = segment.intent;
      check.className = "rail-check";
      check.textContent = state.accepted.has(segment.id) ? "✓" : "·";

      if (index === state.currentIndex) button.setAttribute("aria-current", "step");
      button.type = "button";
      button.setAttribute("aria-label", `跳到 ${segment.id} ${segment.intent}`);
      button.addEventListener("click", () => goToSegment(index));
      button.append(id, label, check);
      item.append(button);
      elements.segmentRail.append(item);
    });
  }

  function renderProgress() {
    const acceptedTakes = [...state.accepted.values()];
    const acceptedCount = acceptedTakes.length;
    const totalSeconds = acceptedTakes.reduce((sum, take) => sum + take.durationSeconds, 0);
    const total = project.segments.length;
    const percent = total ? (acceptedCount / total) * 100 : 0;

    elements.progressFraction.textContent = `${pad(acceptedCount)} / ${pad(total)}`;
    elements.progressFill.style.width = `${percent}%`;
    elements.recordedDuration.textContent = `已收录 ${formatDuration(totalSeconds)}`;

    const canExport = acceptedCount >= EXPORT_MIN_SEGMENTS && !state.isRecording && !state.isSaving;
    elements.exportAudio.disabled = !canExport;
    elements.exportManifest.disabled = !canExport;
    elements.exportStatus.textContent = canExport
      ? `已收下 ${acceptedCount} 段，共 ${formatDuration(totalSeconds)}。可以导出；建议补齐全部 ${total} 段。`
      : `已收下 ${acceptedCount} 段；至少还需 ${EXPORT_MIN_SEGMENTS - acceptedCount} 段才能导出。`;

    buildRail();
  }

  function setTakeResult(take) {
    if (!take) {
      elements.takeResult.hidden = true;
      elements.takePreview.removeAttribute("src");
      elements.takePreview.load();
      revokePreviewUrl();
      return;
    }

    elements.takeResult.hidden = false;
    setPreview(take);
    elements.metricDuration.textContent = `${take.durationSeconds.toFixed(1)} 秒`;
    elements.metricPeak.textContent = formatDb(take.metrics.peakDbfs);
    elements.metricRms.textContent = formatDb(take.metrics.rmsDbfs);
    elements.metricClipping.textContent = `${(take.metrics.clippingRatio * 100).toFixed(3)}%`;
    elements.qualityBadge.textContent = take.quality.label;
    elements.qualityBadge.dataset.quality = take.quality.level;
    elements.qualityNote.textContent = take.quality.notes.join(" ");
    elements.accept.textContent = state.accepted.has(take.segmentId) ? "用这条替换并继续" : "收下并继续";
  }

  function renderSegment() {
    const segment = project.segments[state.currentIndex];
    elements.segmentId.textContent = segment.id;
    elements.segmentIntent.textContent = segment.intent;
    elements.segmentEstimate.textContent = `约 ${segment.estimateSeconds} 秒`;
    elements.promptText.textContent = segment.text;
    elements.deliveryNote.textContent = segment.delivery;
    elements.navStatus.textContent = `第 ${state.currentIndex + 1} 段，共 ${project.segments.length} 段`;
    elements.previous.disabled = state.currentIndex === 0 || state.isRecording;
    elements.next.disabled = state.currentIndex === project.segments.length - 1 || state.isRecording;

    const acceptedTake = state.accepted.get(segment.id);
    state.currentTake = acceptedTake || null;
    setTakeResult(state.currentTake);
    buildRail();
    updateControls();
  }

  function goToSegment(index) {
    if (state.isRecording) {
      showToast("请先停止当前录音，再切换段落。");
      return;
    }
    const safeIndex = Math.max(0, Math.min(project.segments.length - 1, index));
    state.currentIndex = safeIndex;
    renderSegment();
    document.querySelector("#promptTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateControls() {
    const connected = Boolean(state.stream && state.audioContext);
    const consented = elements.consent.checked;
    elements.connect.disabled = state.isRecording || state.isConnecting || state.isSaving;
    elements.record.disabled = !connected || !consented || state.isRecording || state.isConnecting || state.isSaving;
    elements.downloadTake.disabled = state.isSaving;
    const canExport = state.accepted.size >= EXPORT_MIN_SEGMENTS && !state.isRecording && !state.isSaving;
    elements.exportAudio.disabled = !canExport;
    elements.exportManifest.disabled = !canExport;
    elements.stop.disabled = !state.isRecording;
    elements.previous.disabled = state.currentIndex === 0 || state.isRecording;
    elements.next.disabled = state.currentIndex === project.segments.length - 1 || state.isRecording;
    elements.recordLabel.textContent = state.isRecording ? "正在录音…" : "开始录这一段";
  }

  function stopMediaGraph() {
    window.cancelAnimationFrame(state.meterFrame);
    state.meterFrame = null;
    if (state.processorNode) state.processorNode.onaudioprocess = null;
    state.stream?.getTracks().forEach((track) => track.stop());
    state.audioContext?.close().catch(() => {});
    state.stream = null;
    state.audioContext = null;
    state.sourceNode = null;
    state.analyserNode = null;
    state.processorNode = null;
    state.silentGainNode = null;
    elements.levelFill.style.width = "0%";
    elements.liveDb.textContent = "−∞ dBFS";
  }

  async function connectMicrophone() {
    if (state.isConnecting || state.isRecording) return;
    if (!elements.consent.checked) {
      showToast("请先确认声音所有权和用途边界。");
      elements.consent.focus();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState("浏览器不支持录音", "idle");
      showToast("当前浏览器不支持麦克风采集。请使用新版 Chrome 或 Edge，并从 localhost 打开本页。");
      return;
    }

    state.isConnecting = true;
    updateControls();
    elements.micHelp.hidden = true;
    setMicState("正在请求权限", "idle");

    try {
      stopMediaGraph();
      if (desktop && !await desktop.requestMicrophone()) {
        throw new DOMException("Microphone permission denied", "NotAllowedError");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: TARGET_SAMPLE_RATE },
          sampleSize: { ideal: 24 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      state.stream = stream;
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: "interactive" });
      state.audioContext = context;
      await context.resume();

      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.35;

      source.connect(analyser);
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);

      processor.onaudioprocess = (event) => {
        if (!state.isRecording) return;
        const channel = event.inputBuffer.getChannelData(0);
        state.recordingChunks.push(new Float32Array(channel));
      };

      state.stream = stream;
      state.audioContext = context;
      state.sourceNode = source;
      state.analyserNode = analyser;
      state.processorNode = processor;
      state.silentGainNode = silentGain;
      stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => {
        if (state.stream !== stream) return;
        if (state.isRecording) stopRecording();
        stopMediaGraph();
        setMicState("麦克风已断开", "idle");
        showToast("麦克风已断开。请重新接好设备，再点击“连接麦克风”。");
        updateControls();
      }));
      setMicState(`已连接 · ${context.sampleRate / 1000} kHz`, "ready");
      runMeter();
      showToast("麦克风已连接。先正常说两句，观察峰值是否落在安全区间。");
    } catch (error) {
      console.error(error);
      stopMediaGraph();
      setMicState("麦克风连接失败", "idle");
      const help = error.name === "NotFoundError"
        ? "没有找到麦克风。请接好设备，并在系统声音设置中选择输入设备。"
        : error.name === "NotReadableError"
          ? "麦克风无法读取。请检查设备连接，关闭其他占用麦克风的应用后重试。"
          : desktop?.platform === "darwin"
            ? "请在“系统设置 → 隐私与安全性 → 麦克风”中允许“Voice Capture”，然后退出并重新打开应用。输入设备可在“系统设置 → 声音 → 输入”中选择。"
            : "没有取得麦克风权限。请检查麦克风设置与浏览器权限；网页版需从 localhost 打开。";
      elements.micHelp.textContent = help;
      elements.micHelp.hidden = false;
      showToast(help);
    } finally {
      state.isConnecting = false;
      updateControls();
    }
  }

  function runMeter() {
    if (!state.analyserNode) return;
    const buffer = new Float32Array(state.analyserNode.fftSize);

    const draw = () => {
      if (!state.analyserNode) return;
      state.analyserNode.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
      const valueDb = dbfs(peak);
      const normalized = Number.isFinite(valueDb) ? Math.min(100, Math.max(0, ((valueDb + 60) / 60) * 100)) : 0;
      elements.levelFill.style.width = `${normalized}%`;
      elements.liveDb.textContent = formatDb(valueDb);
      state.meterFrame = window.requestAnimationFrame(draw);
    };
    draw();
  }

  function startRecording() {
    if (!state.audioContext || !state.stream) {
      showToast("请先连接麦克风。");
      return;
    }
    if (!elements.consent.checked) {
      showToast("请先确认声音所有权和用途边界。");
      return;
    }

    state.recordingChunks = [];
    state.recordingStartedAt = performance.now();
    state.isRecording = true;
    state.currentTake = null;
    setTakeResult(null);
    setMicState("REC · 正在录音", "recording");
    updateControls();
  }

  function stopRecording() {
    if (!state.isRecording) return;
    state.isRecording = false;
    setMicState(`已连接 · ${state.audioContext.sampleRate / 1000} kHz`, "ready");
    updateControls();

    const sourceRate = state.audioContext.sampleRate;
    const rawSamples = flattenChunks(state.recordingChunks);
    state.recordingChunks = [];
    if (rawSamples.length === 0) {
      showToast("没有收到音频数据，请重新连接麦克风后再试。");
      return;
    }

    const segment = project.segments[state.currentIndex];
    const metrics = analyzeSamples(rawSamples, sourceRate);
    const resampled = resampleLinear(rawSamples, sourceRate, TARGET_SAMPLE_RATE);
    const pcm = floatToPcm16(resampled);
    const blob = encodeWavPcm16(pcm, TARGET_SAMPLE_RATE);
    const quality = gradeTake(metrics, segment.estimateSeconds);

    state.currentTake = {
      segmentId: segment.id,
      segmentIndex: state.currentIndex,
      intent: segment.intent,
      text: segment.text,
      delivery: segment.delivery,
      recordedAt: new Date().toISOString(),
      sourceSampleRate: sourceRate,
      outputSampleRate: TARGET_SAMPLE_RATE,
      outputBitDepth: 16,
      outputChannels: 1,
      durationSeconds: pcm.length / TARGET_SAMPLE_RATE,
      pcm,
      blob,
      metrics,
      quality,
      takeNumber: (state.accepted.get(segment.id)?.takeNumber || 0) + 1
    };
    setTakeResult(state.currentTake);
    if (quality.level === "bad") showToast("这条有明显质量风险，建议先复听再决定是否收下。");
  }

  function acceptCurrentTake() {
    if (!state.currentTake) return;
    state.accepted.set(state.currentTake.segmentId, state.currentTake);
    state.exportStamp = safeFileTimestamp();
    renderProgress();
    showToast(`${state.currentTake.segmentId} 已收下。`);

    const nextIncomplete = project.segments.findIndex((segment, index) => index > state.currentIndex && !state.accepted.has(segment.id));
    if (nextIncomplete >= 0) {
      state.currentIndex = nextIncomplete;
    } else if (state.currentIndex < project.segments.length - 1) {
      state.currentIndex += 1;
    }
    renderSegment();
  }

  function retakeCurrent() {
    state.currentTake = null;
    setTakeResult(null);
    showToast("原先已收下的版本仍保留；录好新版本并点击“替换”后才会覆盖。");
  }

  function safeFileTimestamp() {
    const now = new Date();
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  async function downloadBlob(blob, filename) {
    if (desktop) {
      if (state.isSaving) return false;
      state.isSaving = true;
      updateControls();
      elements.exportStatus.textContent = "正在保存，请在弹出的窗口中选择位置…";
      try {
        const result = await desktop.saveFile(filename, new Uint8Array(await blob.arrayBuffer()));
        if (result.status === "saved") return true;
        const message = result.status === "cancelled" ? "已取消保存，录音仍保留在当前窗口中。" : result.message;
        elements.exportStatus.textContent = message;
        showToast(message);
        return false;
      } catch (error) {
        console.error(error);
        const message = "保存失败，请检查磁盘空间和文件夹权限后重试。";
        elements.exportStatus.textContent = message;
        showToast(message);
        return false;
      } finally {
        state.isSaving = false;
        updateControls();
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  async function downloadCurrentTake() {
    if (!state.currentTake) return;
    const name = `OWNER_${state.currentTake.segmentId}_take${pad(state.currentTake.takeNumber)}_${safeFileTimestamp()}.wav`;
    if (await downloadBlob(state.currentTake.blob, name)) {
      elements.exportStatus.textContent = "本段 WAV 已保存。";
    }
  }

  function buildCombinedExport() {
    const orderedTakes = project.segments
      .map((segment) => state.accepted.get(segment.id))
      .filter(Boolean);
    const silenceLength = Math.round(TARGET_SAMPLE_RATE * INTER_SEGMENT_SILENCE_SECONDS);
    const silence = new Int16Array(silenceLength);
    const totalLength = orderedTakes.reduce((sum, take, index) => {
      return sum + take.pcm.length + (index < orderedTakes.length - 1 ? silence.length : 0);
    }, 0);
    const combined = new Int16Array(totalLength);
    const entries = [];
    let cursor = 0;

    orderedTakes.forEach((take, index) => {
      const startSample = cursor;
      combined.set(take.pcm, cursor);
      cursor += take.pcm.length;
      const endSample = cursor;
      entries.push({
        segmentId: take.segmentId,
        intent: take.intent,
        text: take.text,
        delivery: take.delivery,
        takeNumber: take.takeNumber,
        recordedAt: take.recordedAt,
        startSeconds: startSample / TARGET_SAMPLE_RATE,
        endSeconds: endSample / TARGET_SAMPLE_RATE,
        durationSeconds: take.durationSeconds,
        quality: take.quality,
        metrics: take.metrics
      });
      if (index < orderedTakes.length - 1) {
        combined.set(silence, cursor);
        cursor += silence.length;
      }
    });

    return {
      blob: encodeWavPcm16(combined, TARGET_SAMPLE_RATE),
      durationSeconds: combined.length / TARGET_SAMPLE_RATE,
      entries
    };
  }

  function buildManifest(combinedExport = null) {
    const exportData = combinedExport || buildCombinedExport();
    return {
      schemaVersion: 1,
      projectId: project.projectId,
      voiceId: project.voiceId,
      voiceOwner: "current_user",
      authorizationScope: "three_podcast_episodes_trial_and_narration_only",
      authorizationStatus: "expressed_by_user_and_recorded_in_segment_S01",
      prohibitedUses: [
        "participant_voice_cloning",
        "third_party_impersonation",
        "use_outside_this_project_without_new_authorization"
      ],
      createdAt: new Date().toISOString(),
      recordingEnvironment: desktop ? "local_desktop_no_automatic_upload" : "local_browser_no_automatic_upload",
      output: {
        format: "PCM_WAV",
        sampleRateHz: TARGET_SAMPLE_RATE,
        bitDepth: 16,
        channels: 1,
        interSegmentSilenceSeconds: INTER_SEGMENT_SILENCE_SECONDS,
        totalDurationSeconds: exportData.durationSeconds,
        acceptedSegmentCount: exportData.entries.length,
        expectedSegmentCount: project.segments.length
      },
      qualityReminder: "Browser metrics do not replace headphone review for room noise, reverb, mouth clicks, pronunciation, and privacy.",
      segments: exportData.entries
    };
  }

  async function exportCombinedAudio() {
    const combined = buildCombinedExport();
    if (await downloadBlob(combined.blob, `OWNER_voice_dataset_${state.exportStamp}_48k_pcm16_mono.wav`)) {
      elements.exportStatus.textContent = `合并 WAV 已导出：${formatDuration(combined.durationSeconds)}，${combined.entries.length} 段。请再导出 JSON 清单。`;
    }
  }

  async function exportManifest() {
    const combined = buildCombinedExport();
    const manifest = buildManifest(combined);
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json;charset=utf-8" });
    if (await downloadBlob(blob, `OWNER_voice_dataset_${state.exportStamp}_manifest.json`)) {
      elements.exportStatus.textContent = `质量清单已导出：${manifest.output.acceptedSegmentCount} 段。请把 WAV 与 JSON 放在同一文件夹。`;
    }
  }

  elements.consent.addEventListener("change", updateControls);
  elements.connect.addEventListener("click", connectMicrophone);
  elements.record.addEventListener("click", startRecording);
  elements.stop.addEventListener("click", stopRecording);
  elements.retake.addEventListener("click", retakeCurrent);
  elements.accept.addEventListener("click", acceptCurrentTake);
  elements.downloadTake.addEventListener("click", downloadCurrentTake);
  elements.previous.addEventListener("click", () => goToSegment(state.currentIndex - 1));
  elements.next.addEventListener("click", () => goToSegment(state.currentIndex + 1));
  elements.exportAudio.addEventListener("click", exportCombinedAudio);
  elements.exportManifest.addEventListener("click", exportManifest);

  window.addEventListener("beforeunload", (event) => {
    if (state.accepted.size === 0 && !state.currentTake && !state.isRecording && !state.isSaving) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", () => {
    if (!state.isRecording) stopMediaGraph();
    revokePreviewUrl();
  });

  window.__VOICE_CAPTURE_TEST__ = {
    analyzeSamples,
    gradeTake,
    resampleLinear,
    encodeWavPcm16,
    formatDuration
  };

  renderProgress();
  renderSegment();
  updateControls();
})();
