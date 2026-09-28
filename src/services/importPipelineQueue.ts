export type ImportPipelineTask = (enqueue: (tasks: ImportPipelineTask[], first?: boolean) => void) => Promise<void>;

/** A small dynamic queue: newly detected forms can run before later pages. */
export async function runImportPipelineQueue(initial: ImportPipelineTask[], width: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isInteger(width) || width < 1 || width > 2) throw new Error("Invalid import pipeline width");
  const queue = [...initial];
  let active = 0;
  let failure: unknown;
  await new Promise<void>((resolve) => {
    const pump = () => {
      if (signal?.aborted || failure) queue.length = 0;
      while (active < width && queue.length) {
        const task = queue.shift()!;
        active++;
        void Promise.resolve().then(() => task((tasks, first = false) => {
          if (signal?.aborted || failure) return;
          if (first) queue.unshift(...tasks); else queue.push(...tasks);
          pump();
        })).catch(error => { failure ??= error; }).finally(() => {
          active--;
          pump();
        });
      }
      if (!active && !queue.length) resolve();
    };
    pump();
  });
  if (failure) throw failure;
  signal?.throwIfAborted();
}
