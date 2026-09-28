// Browsers may leave getUserMedia pending forever when a permission prompt is
// ignored. A cancelled/timed-out prompt can still resolve later; stop its tracks.
export function acquireMicrophone(
  request: () => Promise<MediaStream>,
  signal: AbortSignal,
  timeoutMs = 30000,
): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, stream?: MediaStream) => {
      if (settled) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve(stream!);
    };
    const cancel = () =>
      finish(new DOMException("Call cancelled", "AbortError"));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "The microphone prompt is still waiting. Allow access in your browser and call again, or keep chatting here.",
          ),
        ),
      timeoutMs,
    );
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted)
          throw new DOMException("Call cancelled", "AbortError");
        return request();
      })
      .then(
        (stream) => finish(undefined, stream),
        (error: Error) => finish(error),
      );
  });
}
