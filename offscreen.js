// Plays short synthesized alert tones (no audio files needed).
const TONES = {
  chime: [[880, 0, 0.18], [1320, 0.16, 0.32]],
  beep: [[1000, 0, 0.12], [1000, 0.2, 0.12]],
  alert: [[700, 0, 0.12], [940, 0.14, 0.12], [700, 0.28, 0.12], [940, 0.42, 0.18]],
  soft: [[523, 0, 0.3], [659, 0.18, 0.4]],
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'play') return;
  const ctx = new AudioContext();
  const notes = TONES[msg.tone] || TONES.chime;
  const vol = Math.max(0, Math.min(1, msg.volume ?? 0.6)) * 0.5;
  const repeat = msg.level === 'limit' ? 2 : 1;
  let end = 0;
  for (let r = 0; r < repeat; r++) {
    const off = r * 0.7;
    for (const [freq, start, dur] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = msg.tone === 'alert' ? 'square' : 'sine';
      o.frequency.value = freq;
      const t0 = ctx.currentTime + off + start;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
      end = Math.max(end, off + start + dur);
    }
  }
  setTimeout(() => ctx.close(), (end + 0.5) * 1000);
});
