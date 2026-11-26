// A fake oa-<p>-fleet-wake batch (cloud #264): one message per entry of
// `attempts` (its delivery count), recording each ack and retry.
export function wakeBatch(attempts: number[] = [1], at = 0) {
  const acked: number[] = [];
  const retried: { i: number; delaySeconds: number | undefined }[] = [];
  const messages = attempts.map((a, i) => ({
    id: `m${i}`,
    timestamp: new Date(at),
    body: { env: "staging", tag: "v0.93.0" },
    attempts: a,
    ack: () => {
      acked.push(i);
    },
    retry: (o?: { delaySeconds?: number }) => {
      retried.push({ i, delaySeconds: o?.delaySeconds });
    },
  }));
  const batch = {
    queue: "oa-s-fleet-wake",
    messages,
    ackAll: () => {
      throw new Error("ackAll: the wake acks each message");
    },
    retryAll: () => {
      throw new Error("retryAll: the wake retries one message at most");
    },
  } as unknown as MessageBatch<unknown>;
  return { batch, acked, retried };
}
