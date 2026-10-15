import { requestUrl } from "obsidian";
import type { PluginManifest } from "obsidian";

type PackageAsset = "manifest.json" | "main.js" | "styles.css";

const REGISTRY_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const MAX_BYTES: Record<PackageAsset, number> = {
  "manifest.json": 1024 * 1024,
  "main.js": 25 * 1024 * 1024,
  "styles.css": 5 * 1024 * 1024,
};

export interface ResolvedPackage {
  manifest: PluginManifest;
  assets: { mainJs: ArrayBuffer; stylesCss: ArrayBuffer | null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRepo(repo: unknown): repo is string {
  return typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

export class OfficialPackageSource {
  private registry: Promise<Map<string, string>> | null = null;

  async resolve(manifest: PluginManifest): Promise<ResolvedPackage> {
    const repo = await this.resolveRepository(manifest.id);
    const releaseUrl = `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/releases/download/${encodeURIComponent(manifest.version)}`;
    const remoteManifestBytes = await this.downloadAsset("manifest.json", releaseUrl);
    const remoteManifest = this.parseManifest(remoteManifestBytes);
    if (
      remoteManifest.id !== manifest.id ||
      remoteManifest.version !== manifest.version ||
      remoteManifest.minAppVersion !== manifest.minAppVersion ||
      Boolean(remoteManifest.isDesktopOnly) !== Boolean(manifest.isDesktopOnly)
    ) throw new Error("Release manifest does not match synchronized manifest");

    const mainJs = await this.downloadAsset("main.js", releaseUrl);
    const stylesCss = await this.downloadAsset("styles.css", releaseUrl);
    return { manifest: remoteManifest, assets: { mainJs, stylesCss } };
  }

  private async resolveRepository(id: string): Promise<string> {
    if (!this.registry) {
      const registryRequest = (async () => {
        const response = await requestUrl({ url: REGISTRY_URL, throw: false });
        if (response.status < 200 || response.status >= 300 || !Array.isArray(response.json)) {
          throw new Error(`Official plugin registry unavailable (HTTP ${response.status})`);
        }
        const result = new Map<string, string>();
        for (const item of response.json) {
          if (!isRecord(item) || typeof item.id !== "string" || !validRepo(item.repo)) continue;
          if (result.has(item.id)) throw new Error(`Ambiguous official plugin ID: ${item.id}`);
          result.set(item.id, item.repo);
        }
        return result;
      })();
      this.registry = registryRequest;
      void registryRequest.catch(() => {
        if (this.registry === registryRequest) this.registry = null;
      });
    }
    const repo = (await this.registry).get(id);
    if (!repo) throw new Error("Plugin source is not in the official registry");
    return repo;
  }

  private downloadAsset(name: "manifest.json" | "main.js", releaseUrl: string): Promise<ArrayBuffer>;
  private downloadAsset(name: "styles.css", releaseUrl: string): Promise<ArrayBuffer | null>;
  private async downloadAsset(name: PackageAsset, releaseUrl: string): Promise<ArrayBuffer | null> {
    const response = await requestUrl({ url: `${releaseUrl}/${name}`, throw: false });
    if (name === "styles.css" && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300 || !response.arrayBuffer || typeof response.arrayBuffer.byteLength !== "number") {
      throw new Error(`Failed to download ${name} (HTTP ${response.status})`);
    }
    if (response.arrayBuffer.byteLength > MAX_BYTES[name]) throw new Error(`${name} exceeds size limit`);
    return response.arrayBuffer;
  }

  private parseManifest(bytes: ArrayBuffer): PluginManifest {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Invalid release manifest JSON"); }
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "string") {
      throw new Error("Invalid release manifest");
    }
    return value as unknown as PluginManifest;
  }
}
