// Same synthetic microphone and received-audio measurement on both app versions.
export function installAudioProbe() {
  let ac, dest, source, recorder, zero, oscillator;
  const probe = (window.__audioProbe = {
    events: [],
    chunks: [],
    sampleRate: 48000,
    total: 0,
    lastSound: 0,
    peers: [],
  });
  const init = () => {
    if (ac) return;
    ac = new AudioContext({ sampleRate: 48000 });
    probe.sampleRate = ac.sampleRate;
    dest = ac.createMediaStreamDestination();
    oscillator = ac.createOscillator();
    zero = ac.createGain();
    zero.gain.value = 0;
    oscillator.connect(zero).connect(dest);
    oscillator.start();
  };
  navigator.mediaDevices.getUserMedia = async () => {
    init();
    await ac.resume();
    return dest.stream.clone();
  };
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) {
      super(...args);
      probe.peers.push(this);
      this.addEventListener("track", (e) => {
        init();
        const source = ac.createMediaStreamSource(
          e.streams[0] || new MediaStream([e.track]),
        );
        const recorder = ac.createScriptProcessor(1024, 1, 1);
        const mute = ac.createGain();
        mute.gain.value = 0;
        source.connect(recorder).connect(mute).connect(ac.destination);
        const cleanup = () => {
          source.disconnect();
          recorder.disconnect();
          mute.disconnect();
          recorder.onaudioprocess = null;
        };
        e.track.addEventListener("ended", cleanup, { once: true });
        this.addEventListener("connectionstatechange", () => {
          if (this.connectionState === "closed") cleanup();
        });
        recorder.onaudioprocess = (ev) => {
          const samples = Float32Array.from(ev.inputBuffer.getChannelData(0));
          let energy = 0;
          for (const v of samples) energy += v * v;
          const rms = Math.sqrt(energy / samples.length);
          const at = performance.now();
          probe.chunks.push(samples);
          probe.total += samples.length;
          if (rms > 0.003) {
            probe.events.push({ type: "playback.sample", at, rms });
            if (at - probe.lastSound > 180)
              probe.events.push({
                type: "playback.sound.start",
                at,
                sample: probe.total - samples.length,
                rms,
              });
            probe.lastSound = at;
          }
        };
      });
    }
  };
  probe.play = async (base64, id) => {
    init();
    await ac.resume();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await ac.decodeAudioData(bytes.buffer);
    const channel = buffer.getChannelData(0);
    let first = 0,
      last = channel.length - 1;
    while (first < channel.length && Math.abs(channel[first]) < 0.008) first++;
    while (last > first && Math.abs(channel[last]) < 0.008) last--;
    const start = performance.now() + 100;
    const item = {
      type: "microphone.fixture",
      id,
      start: start + (first / buffer.sampleRate) * 1000,
      end: start + (last / buffer.sampleRate) * 1000,
      duration: buffer.duration * 1000,
    };
    probe.events.push(item);
    const player = ac.createBufferSource();
    player.buffer = buffer;
    player.connect(dest);
    player.start(ac.currentTime + 0.1);
    return item;
  };
  probe.export = () => {
    const bytes = new Uint8Array(probe.total * 2);
    const view = new DataView(bytes.buffer);
    let n = 0;
    for (const block of probe.chunks)
      for (const f of block)
        view.setInt16(
          n++ * 2,
          Math.max(-32768, Math.min(32767, Math.round(f * 32767))),
          true,
        );
    let raw = "";
    for (let i = 0; i < bytes.length; i += 16384)
      raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return {
      events: probe.events,
      timeOrigin: performance.timeOrigin,
      rate: probe.sampleRate,
      pcm: btoa(raw),
      app: window.__voiceLabEvents || [],
    };
  };
}
