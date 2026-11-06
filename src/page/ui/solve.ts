import type { NotArrived } from "./ask";

export const solved = (salt: string, bits: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./prove.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", ({ data }: MessageEvent<string>) => {
      worker.terminate();
      resolve(data);
    });
    worker.addEventListener("error", ({ message }) => {
      worker.terminate();
      reject(new Error(message));
    });
    worker.postMessage({ salt, bits });
  });

export const answeringProof = async <T extends object>(
  first: T | NotArrived,
  again: (proof: string) => Promise<T | NotArrived>,
): Promise<T | NotArrived> => {
  const { salt, bits } = first as NotArrived;
  return salt !== undefined && bits !== undefined ? again(await solved(salt, bits)) : first;
};
