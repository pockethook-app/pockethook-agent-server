import { randomBytes, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

interface PendingPairing {
  expiresAt: number;
}

export interface AppleBridgeCredential {
  installationId: string;
  credential: string;
  pairedAt: string;
}

interface StoredPairings {
  credentials?: Record<string, { credential?: string; pairedAt?: string }>;
}

const PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_FILE = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", "apple-bridge.json");

export class AppleBridgePairingStore {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly credentials = new Map<string, AppleBridgeCredential>();

  constructor(private readonly filePath = DEFAULT_FILE) {
    this.load();
  }

  createCode(): { code: string; expiresAt: string } {
    this.removeExpiredCodes();
    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pending.set(code, { expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  pair(installationId: string, suppliedCode: string): { credential: string } {
    if (!installationId || installationId.length > 200) throw new Error("A valid installationId is required");
    const code = suppliedCode.trim().toUpperCase();
    const pending = this.pending.get(code);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending.delete(code);
      throw new Error("Pairing code is invalid or expired");
    }
    this.pending.delete(code);
    const entry: AppleBridgeCredential = {
      installationId,
      credential: randomUUID(),
      pairedAt: new Date().toISOString(),
    };
    // Apple Bridge is a single loopback service on a fixed port. Re-pairing a
    // reinstalled app must replace stale credentials instead of leaving the
    // client to select an older installation.
    this.credentials.clear();
    this.credentials.set(installationId, entry);
    this.save();
    return { credential: entry.credential };
  }

  activeCredential(): AppleBridgeCredential | undefined {
    return this.credentials.values().next().value;
  }

  status(): { paired: Array<{ installationId: string; pairedAt: string }> } {
    return {
      paired: [...this.credentials.values()].map(({ installationId, pairedAt }) => ({ installationId, pairedAt })),
    };
  }

  private removeExpiredCodes(): void {
    for (const [code, pending] of this.pending) {
      if (pending.expiresAt <= Date.now()) this.pending.delete(code);
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoredPairings;
      for (const [installationId, value] of Object.entries(stored.credentials ?? {})) {
        if (typeof value.credential !== "string") continue;
        this.credentials.set(installationId, {
          installationId,
          credential: value.credential,
          pairedAt: typeof value.pairedAt === "string" ? value.pairedAt : "unknown",
        });
      }
    } catch {
      // A corrupt pairing file is treated as unpaired; no secret is accepted.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const credentials = Object.fromEntries(
      [...this.credentials.values()].map(({ installationId, credential, pairedAt }) => [installationId, { credential, pairedAt }]),
    );
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ credentials }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

export const appleBridgePairings = new AppleBridgePairingStore();

export function createAppleBridgePairingCode(): { code: string; expiresAt: string } {
  return appleBridgePairings.createCode();
}

export function pairAppleBridgeInstallation(installationId: string, code: string): { credential: string } {
  return appleBridgePairings.pair(installationId, code);
}

export function getAppleBridgeCredential(): AppleBridgeCredential | undefined {
  return appleBridgePairings.activeCredential();
}

export function appleBridgePairingStatus(): { paired: Array<{ installationId: string; pairedAt: string }> } {
  return appleBridgePairings.status();
}
