import { solveProof } from "../../core/start";

// In a worker of its own, so the page does not stop while thousands of hashes are worked out.
addEventListener("message", async ({ data }: MessageEvent<{ salt: string; bits: number }>) => {
  postMessage(await solveProof(data.salt, data.bits));
});
