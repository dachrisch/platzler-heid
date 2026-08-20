import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PORTALS, getPortal } from "./config.js";
import { scrapeAll, scrapePortal } from "./scraper.js";
import type { AvailabilitySnapshot, PortalConfig } from "./types.js";

const DEFAULT_OUT = resolve(process.cwd(), "data", "availability.json");

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      portal: { type: "string" },
      "max-dates": { type: "string" },
      out: { type: "string" },
      throttle: { type: "string" },
      concurrency: { type: "string" },
    },
  });

  const out = values.out ? resolve(process.cwd(), values.out) : DEFAULT_OUT;
  const throttleMs = values.throttle ? Number(values.throttle) : undefined;
  const concurrency = values.concurrency ? Number(values.concurrency) : undefined;
  const maxDates = values["max-dates"] ? Number(values["max-dates"]) : undefined;

  let portals: PortalConfig[];
  if (values.portal) {
    const cfg = getPortal(values.portal);
    if (!cfg) {
      console.error(`Unknown portal "${values.portal}". Available: ${PORTALS.map((p) => p.id).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    portals = [cfg];
  } else {
    portals = PORTALS;
  }

  log(`Scraping ${portals.length} portal(s)…`);
  const started = Date.now();

  const snapshot: AvailabilitySnapshot =
    portals.length === 1
      ? {
          fetchedAt: new Date().toISOString(),
          portals: [await scrapePortal(portals[0], { throttleMs, concurrency, maxDates, onProgress: log })],
        }
      : await scrapeAll(portals, {
          throttleMs,
          concurrency,
          maxDates,
          onProgress: log,
        });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  log(`Wrote ${out} (${(Date.now() - started) / 1000}s)`);

  const portalsWithData = snapshot.portals.filter((p) => p.dates.length > 0);
  const failed = snapshot.portals.filter((p) => p.error);
  log(
    `Summary: ${portalsWithData.length}/${snapshot.portals.length} portals with availability, ` +
      `${failed.length} with errors`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}