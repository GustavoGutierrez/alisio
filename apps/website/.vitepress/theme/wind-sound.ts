/**
 * A short wind gust ("fuuush"), synthesized with the Web Audio API so the site ships no audio file.
 * Filtered noise sweeps across the stereo field from east (right) to west (left), matching the
 * showcase slide animation. Only call it from a user gesture (a click), never from autoplay: browsers
 * only allow audio after one, and the site never makes sound on its own.
 *
 * "forward" is a brighter gust with a hiss at the end ("fuuush"); "back" is a lower, rounder one
 * ("fuuuu").
 */
let ctx: AudioContext | undefined;
let noise: AudioBuffer | undefined;

function context(): AudioContext | undefined {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined;
  ctx = new Ctor();
  // Two seconds of pink-ish noise, reused by every gust.
  const length = ctx.sampleRate * 2;
  noise = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = noise.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    last = 0.97 * last + 0.03 * (Math.random() * 2 - 1);
    data[i] = last * 6;
  }
  return ctx;
}

export function playWindGust(direction: "forward" | "back" = "forward"): void {
  try {
    const audio = context();
    if (!audio || !noise) return;
    if (audio.state === "suspended") void audio.resume();

    const forward = direction === "forward";
    const now = audio.currentTime;
    const duration = forward ? 0.95 : 1.1;

    const source = audio.createBufferSource();
    source.buffer = noise;

    // The body of the gust: a band of noise whose centre rises and falls like a passing breath.
    const band = audio.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = forward ? 1.1 : 1.4;
    const [low, peak, end] = forward ? [420, 1500, 2600] : [300, 900, 380];
    band.frequency.setValueAtTime(low, now);
    band.frequency.exponentialRampToValueAtTime(peak, now + duration * 0.35);
    band.frequency.exponentialRampToValueAtTime(end, now + duration);

    // Rounds off the harsh top end so it reads as air, not static.
    const soft = audio.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = forward ? 4200 : 2200;

    // Swell in, then fade out slowly.
    const gain = audio.createGain();
    const level = forward ? 0.32 : 0.36;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + duration * 0.3);
    gain.gain.exponentialRampToValueAtTime(level * 0.55, now + duration * 0.65);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    let tail: AudioNode = gain;
    if (typeof audio.createStereoPanner === "function") {
      const pan = audio.createStereoPanner();
      pan.pan.setValueAtTime(forward ? 0.7 : -0.7, now);
      pan.pan.linearRampToValueAtTime(forward ? -0.7 : 0.7, now + duration);
      gain.connect(pan);
      tail = pan;
    }

    source.connect(band).connect(soft).connect(gain);
    tail.connect(audio.destination);
    source.start(now, Math.random() * 0.8, duration);
    source.stop(now + duration + 0.05);
  } catch {
    // Sound is decoration: never let it break the slider.
  }
}
