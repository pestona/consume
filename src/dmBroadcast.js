import { logJson, sleep } from "./util.js";

/** Очередь: один массовый DM за раз, чтобы не ловить global rate limit. */
let chain = Promise.resolve();

const DELAY_MS = 1300;
const JITTER_MS = 400;
const BATCH_SIZE = 12;
const BATCH_PAUSE_MS = 7000;

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => null,
    () => null,
  );
  return run;
}

function retryWaitMs(err) {
  if (err?.retryAfter != null) return Number(err.retryAfter) * 1000 + 300;
  if (err?.timeout != null) return Number(err.timeout) + 300;
  const raw = err?.rawError?.retry_after ?? err?.data?.retry_after;
  if (raw != null) return Number(raw) * 1000 + 300;
  return 5000;
}

function isRateLimit(err) {
  return err?.status === 429 || err?.httpStatus === 429 || err?.code === 429 || err?.name === "RateLimitError";
}

async function sendOne(user, content) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await user.send(content);
      return true;
    } catch (err) {
      if (isRateLimit(err)) {
        const wait = retryWaitMs(err);
        logJson("WARN", "DM rate limit, пауза", { waitMs: wait, userId: user?.id });
        await sleep(wait);
        continue;
      }
      return false;
    }
  }
  return false;
}

/**
 * Медленная рассылка в ЛС с паузами и обработкой 429.
 * @returns {{ ok: number, fail: number }}
 */
export function broadcastDms(members, content) {
  return enqueue(async () => {
    let ok = 0;
    let fail = 0;
    let i = 0;
    for (const member of members) {
      const user = member.user || member;
      if (!user || user.bot) continue;
      const sent = await sendOne(user, content);
      if (sent) ok += 1;
      else fail += 1;
      i += 1;
      await sleep(DELAY_MS + Math.floor(Math.random() * JITTER_MS));
      if (i % BATCH_SIZE === 0) {
        await sleep(BATCH_PAUSE_MS);
      }
    }
    return { ok, fail };
  });
}
