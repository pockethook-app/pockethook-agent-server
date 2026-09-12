import { createHash } from "node:crypto";
import { responses } from "pockethook-sdk";
import type { Job } from "./jobs.js";
import type { Delivery } from "./deliveries.js";

export function jobResponses(job: Job) {
  if (job.result) {
    try {
      const parsed = JSON.parse(job.result);
      if (Array.isArray(parsed) && parsed.length && parsed.every((item) => typeof item?.msg === "string")) {
        return responses(parsed.map((item) => ({ msg: item.msg, shortcut: item.shortcut, data: item.data, url: item.url })));
      }
    } catch { /* Shell jobs can return plain text. */ }
    if (/^https:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?$/i.test(job.result.trim())) {
      return responses([{ msg: job.result.trim() }]);
    }
    let data: Record<string, unknown> | undefined;
    if (job.on_complete_data) {
      try { data = { ...JSON.parse(job.on_complete_data), output: job.result }; }
      catch { data = { output: job.result }; }
    } else if (job.on_complete_shortcut) data = { output: job.result };
    return responses([{ msg: `✅ Job #${job.id} "${job.name}"\n${job.result}`,
      shortcut: job.on_complete_shortcut ?? undefined, data }]);
  }
  return responses([{ msg: `❌ Job #${job.id} "${job.name}"\n${job.error || "No output"}` }]);
}

export function deliveryResponses(delivery: Delivery) {
  const items = jobResponses(delivery.job);
  return items.map((item, index) => ({ ...item, deliveryId: delivery.id, deliveryCount: items.length,
    messageId: createHash("sha256").update(`${delivery.id}:${index}`).digest("hex") }));
}
