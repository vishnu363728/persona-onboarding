import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createSession } from "../src/lib/domain";
import { saveSession, mutateSession, rawStore } from "../src/lib/store";
import { createLive, superviseLiveCall } from "../src/lib/live";

async function main() {
  const require = createRequire(import.meta.url);
  const wrtc = require("@roamhq/wrtc");
  const pc = new wrtc.RTCPeerConnection();
  const source = new wrtc.nonstandard.RTCAudioSource();
  const track = source.createTrack();
  pc.addTrack(track);
  const dc = pc.createDataChannel("oai-events");
  const events: unknown[] = [];
  dc.onmessage = (message: { data: string }) => {
    const e = JSON.parse(message.data);
    if (["session.started", "session.closed", "error"].includes(e.type)) events.push(e);
  };
  const s = createSession("qa-live-access-" + randomUUID());
  s.profile.agentName = { status: "known", value: "Appy" };
  s.call = { status: "connecting", attempts: 1, direction: "outgoing" };
  await saveSession(s);
  let supervisor: ReturnType<typeof superviseLiveCall> | undefined;
  let pump: ReturnType<typeof setInterval> | undefined;
  let created: Awaited<ReturnType<typeof createLive>> | undefined;
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const until = Date.now() + 8000;
    while (pc.iceGatheringState !== "complete" && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    created = await createLive(s, pc.localDescription.sdp);
    await mutateSession(s.id, current => { current.call.id = created!.callId; current.call.status = "active"; });
    supervisor = superviseLiveCall(s.id, created.callId, created);
    await supervisor.connected;
    await pc.setRemoteDescription({ type: "answer", sdp: created.sdp });
    pump = setInterval(() => source.onData({ samples: new Int16Array(480), sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 }), 10);
    const readyDeadline = Date.now() + 15000;
    while (!events.some((e: any) => e.type === "session.started") && Date.now() < readyDeadline) await new Promise(r => setTimeout(r, 50));
    await supervisor.abort();
    await supervisor.done;
    const receipt = await rawStore.read("voice-usage:" + created.callId);
    const report = { callId: created.callId, model: created.model, started: events.some((e: any) => e.type === "session.started"), closed: events.some((e: any) => e.type === "session.closed"), receipt };
    await mkdir("output/qa/live", { recursive: true });
    await writeFile("output/qa/live/access.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (supervisor) await supervisor.abort();
    clearInterval(pump); track.stop(); dc.close(); pc.close();
  }
}
main().then(() => setTimeout(() => process.exit(0), 100), error => { console.error(error.message); setTimeout(() => process.exit(1), 100); });
