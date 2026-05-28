import type { ReactNode } from "react";
import type { ClusterSourceInfo } from "./tauri";

export interface TelemetryEvent {
  event: string;
  properties?: Record<string, unknown>;
  distinctId?: string;
}

export interface TelemetryService {
  track(event: TelemetryEvent): void | Promise<void>;
}

export interface PluginContext {
  refreshClusters(): void;
  openDeployWizard(): void;
}

export interface ClusterManagerPluginContext {
  sources: ClusterSourceInfo[];
  refreshSources(): Promise<void>;
  notifySourcesChanged(): void;
}

export interface PluginCommand {
  key: string;
  name: string;
  subtitle?: string;
  icon?: ReactNode;
  run(context: PluginContext): void | Promise<void>;
}

export interface AppPlugin {
  id: string;
  telemetry?: TelemetryService;
  topbarActions?: (context: PluginContext) => ReactNode;
  commandActions?: (context: PluginContext) => PluginCommand[];
  clusterManagerSections?: (context: ClusterManagerPluginContext) => ReactNode;
}

export function createTelemetry(plugins: AppPlugin[]): TelemetryService {
  return {
    async track(event) {
      await Promise.all(
        plugins.map((plugin) => Promise.resolve(plugin.telemetry?.track(event)))
      );
    },
  };
}
