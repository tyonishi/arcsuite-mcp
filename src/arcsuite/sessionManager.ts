import type { ArcSuiteAdapterClient } from "./soapAdapterClient.ts";
import { ArcSuiteAdapterError } from "./errors.ts";

export class AdapterSessionManager {
  private readonly adapter: ArcSuiteAdapterClient;
  constructor(adapter: ArcSuiteAdapterClient) { this.adapter = adapter; }

  async executeRead<T>(clientProfileId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ArcSuiteAdapterError) || error.code !== "ARCSUITE_SESSION_EXPIRED") throw error;
      await this.adapter.login(clientProfileId);
      return await operation();
    }
  }
}
