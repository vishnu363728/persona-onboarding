/** Shared offline PCM and macOS speech primitives for live voice harnesses. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export function wavData(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  let format, data;
  for (let p = 12; p + 8 <= buffer.length;) {
    const kind = buffer.toString("ascii", p, p + 4),
      size = buffer.readUInt32LE(p + 4);
    if (kind === "fmt ")
      format = {
        codec: buffer.readUInt16LE(p + 8),
        channels: buffer.readUInt16LE(p + 10),
        rate: buffer.readUInt32LE(p + 12),
        bits: buffer.readUInt16LE(p + 22),
      };
    if (kind === "data") data = buffer.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  assert.deepEqual(format, { codec: 1, channels: 1, rate: 48000, bits: 16 });
  assert.ok(data?.length);
  const result = new Int16Array(data.length / 2);
  for (let p = 0; p < result.length; p++) result[p] = data.readInt16LE(p * 2);
  return result;
}
export function wavBuffer(pcm, format) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.rate, 24);
  header.writeUInt32LE(format.rate * format.channels * 2, 28);
  header.writeUInt16LE(format.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function normalizeAudio(data, receivedFormats = new Set()) {
  // The native sink may emit 16 kHz comfort noise before negotiating 48 kHz Opus.
  // Normalize every frame so the saved WAV has one true sample rate.
  receivedFormats.add(`${data.sampleRate} Hz/${data.channelCount} channel(s)`);
  const inputFrames = data.samples.length / data.channelCount;
  const frames = Math.round((inputFrames * 48000) / data.sampleRate);
  const result = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const position = (i * data.sampleRate) / 48000;
    const lower = Math.min(Math.floor(position), inputFrames - 1);
    const upper = Math.min(lower + 1, inputFrames - 1);
    const fraction = position - lower;
    let value = 0;
    for (let ch = 0; ch < data.channelCount; ch++) {
      value +=
        data.samples[lower * data.channelCount + ch] * (1 - fraction) +
        data.samples[upper * data.channelCount + ch] * fraction;
    }
    result.writeInt16LE(Math.round(value / data.channelCount), i * 2);
  }
  return result;
}
export async function syntheticSpeech(out, name, text) {
  execFileSync("say", [
    "-v",
    "Samantha",
    "-r",
    "155",
    "-o",
    `${out}/${name}.aiff`,
    text,
  ]);
  execFileSync("afconvert", [
    "-f",
    "WAVE",
    "-d",
    "LEI16@48000",
    "-c",
    "1",
    `${out}/${name}.aiff`,
    `${out}/${name}.wav`,
  ]);
  return wavData(await readFile(`${out}/${name}.wav`));
}
