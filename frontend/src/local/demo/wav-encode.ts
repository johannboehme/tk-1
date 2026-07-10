/**
 * Minimal 16-bit PCM WAV writer. Used by the demo-project synthesizer
 * to turn the rendered song PCM into a normal audio file that flows
 * through the regular upload pipeline (`decodeAudioToMonoPcm`, sync,
 * waveform) exactly like a user's own WAV would.
 */

/**
 * Encode interleaved Float32 samples ([-1, 1], layout [L0, R0, L1, …]
 * for stereo, plain samples for mono) as a 16-bit PCM WAV.
 * Out-of-range samples are clamped, not wrapped.
 */
export function encodeWavPcm16(
  samples: Float32Array,
  channels: number,
  sampleRate: number,
): ArrayBuffer {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);

  // RIFF header
  dv.setUint32(0, 0x52494646, false); // "RIFF"
  dv.setUint32(4, 36 + dataLen, true);
  dv.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  dv.setUint32(12, 0x666d7420, false); // "fmt "
  dv.setUint32(16, 16, true); // chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true); // byte rate
  dv.setUint16(32, channels * 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  // data chunk
  dv.setUint32(36, 0x64617461, false); // "data"
  dv.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}
