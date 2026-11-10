import { createHash } from "node:crypto";
import { ErrorReply } from "redis";

export type RedisScriptCommandOptions = {
  deadlineAt: number;
  signal?: AbortSignal;
  isReady(): boolean;
  canContinue(): boolean;
  now?: () => number;
};

/** Run inside the caller's existing bounded Redis operation, not a second
 * publication. Script digests are stateless: no dynamic arguments, scripts or
 * keys enter a process-lifetime registry. Redis owns the compiled script cache.
 * A server NOSCRIPT reply proves EVALSHA did not execute; no other failure does. */
export async function executeRedisScriptCommand<T>(
  send: (args: string[]) => Promise<T>,
  args: string[],
  options: RedisScriptCommandOptions,
): Promise<T> {
  const script = args[1];
  if (args[0]?.toUpperCase() !== "EVAL" || script === undefined || args.length < 3) {
    return send(args);
  }
  const original = [...args];
  const digest = createHash("sha1").update(script).digest("hex");
  try {
    return await send(["EVALSHA", digest, ...original.slice(2)]);
  } catch (error) {
    if (!(error instanceof ErrorReply) || !/^NOSCRIPT(?:\s|$)/.test(error.message)
      || options.signal?.aborted || !options.isReady() || !options.canContinue()
      || (options.now?.() ?? performance.now()) >= options.deadlineAt) {
      throw error;
    }
    // The exact original EVAL both executes and fills Redis's script cache.
    // Return its promise directly: even a second NOSCRIPT is never retried.
    return send(original);
  }
}
